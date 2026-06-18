# subagent/backend.py
# Parallel task orchestration: decompose → run N agents simultaneously → synthesize.
# Uses Odysseus's internal LLM stack (stream_llm + endpoint_resolver) directly.

import asyncio
import json
import logging
import time
import uuid
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger("pkg_subagent")

# ── in-memory job store ────────────────────────────────────────────────────────

_jobs: Dict[str, Dict] = {}   # job_id → job dict


def _new_job(task: str) -> Dict:
    jid = uuid.uuid4().hex[:10]
    job = {
        "id": jid,
        "task": task,
        "status": "pending",   # pending | planning | running | synthesizing | done | error
        "subtasks": [],
        "agents": {},           # subtask_id → {status, output, done}
        "result": "",
        "error": "",
        "created_at": time.time(),
        "finished_at": None,
    }
    _jobs[jid] = job
    # Keep only the last 20 jobs to avoid memory leaks
    if len(_jobs) > 20:
        oldest = sorted(_jobs.keys(), key=lambda k: _jobs[k]["created_at"])
        for k in oldest[:-20]:
            del _jobs[k]
    return job


# ── LLM helpers ───────────────────────────────────────────────────────────────

def _resolve_llm() -> Tuple[Optional[str], Optional[str], Optional[Dict]]:
    """Get (url, model, headers) for the default endpoint."""
    try:
        from src.endpoint_resolver import resolve_endpoint
        return resolve_endpoint("default")
    except Exception as e:
        logger.warning(f"[subagent] Could not resolve endpoint: {e}")
        return None, None, None


async def _llm_complete(messages: List[Dict], url: str, model: str,
                        headers: Optional[Dict] = None, max_tokens: int = 4096) -> str:
    """Collect full LLM response (non-streaming accumulation)."""
    from src.llm_core import stream_llm
    full = []
    async for chunk in stream_llm(
        url, model, messages,
        headers=headers,
        max_tokens=max_tokens,
    ):
        # chunk is an SSE line like "data: {json}"
        if not chunk.startswith("data:"):
            continue
        payload = chunk[5:].strip()
        if payload == "[DONE]":
            break
        try:
            d = json.loads(payload)
            if "delta" in d:
                full.append(d["delta"])
        except Exception:
            pass
    return "".join(full)


async def _llm_stream_to_queue(
    messages: List[Dict],
    url: str, model: str,
    headers: Optional[Dict],
    queue: asyncio.Queue,
    subtask_id: int,
    max_tokens: int = 4096,
) -> str:
    """Stream LLM response, sending delta events to queue. Returns full text."""
    from src.llm_core import stream_llm
    full = []
    try:
        async for chunk in stream_llm(
            url, model, messages,
            headers=headers,
            max_tokens=max_tokens,
        ):
            if not chunk.startswith("data:"):
                continue
            payload = chunk[5:].strip()
            if payload == "[DONE]":
                break
            try:
                d = json.loads(payload)
                if "delta" in d and d["delta"]:
                    full.append(d["delta"])
                    await queue.put({"type": "delta", "id": subtask_id, "delta": d["delta"]})
            except Exception:
                pass
    except Exception as e:
        logger.error(f"[subagent] LLM stream error for subtask {subtask_id}: {e}")
        await queue.put({"type": "subtask_error", "id": subtask_id, "error": str(e)})
    text = "".join(full)
    await queue.put({"type": "subtask_done", "id": subtask_id, "output": text})
    return text


# ── orchestration logic ────────────────────────────────────────────────────────

_PLAN_SYSTEM = """You are a task decomposition expert. Break the given task into independent parallel subtasks for separate AI agents.

Rules:
- Maximum 6 subtasks; minimum 1
- Each subtask must be self-contained and executable independently
- If the task is simple/short, return just 1 subtask
- Write each subtask description in the SAME language as the original task
- Return ONLY valid JSON, no markdown fences

Format:
[
  {"id": 1, "title": "Short title", "task": "Full instructions for this agent. Include all context it needs."},
  ...
]"""


async def _plan(task: str, url: str, model: str, headers: Optional[Dict]) -> List[Dict]:
    """Ask LLM to decompose task into parallel subtasks. Returns list of subtask dicts."""
    messages = [
        {"role": "system", "content": _PLAN_SYSTEM},
        {"role": "user", "content": f"Decompose this task:\n\n{task}"},
    ]
    raw = await _llm_complete(messages, url, model, headers, max_tokens=1024)

    # Extract JSON array from response
    import re
    m = re.search(r'\[[\s\S]+\]', raw)
    if not m:
        logger.warning(f"[subagent] Planner returned non-JSON: {raw[:200]}")
        return [{"id": 1, "title": "Main Task", "task": task}]
    try:
        subtasks = json.loads(m.group())
        # Validate structure
        for i, st in enumerate(subtasks):
            if "id" not in st:
                st["id"] = i + 1
            if "title" not in st:
                st["title"] = f"Task {i + 1}"
            if "task" not in st:
                st["task"] = task
        return subtasks[:6]  # cap at 6
    except json.JSONDecodeError as e:
        logger.warning(f"[subagent] Planner JSON parse error: {e}")
        return [{"id": 1, "title": "Main Task", "task": task}]


_SYNTH_SYSTEM = """You are a synthesis expert. Combine the outputs from multiple parallel AI agents into a single coherent, well-structured response.

Rules:
- Merge without redundancy
- Preserve all important information
- Write in the SAME language as the original task
- Structure the response clearly (use headers/bullets where helpful)
- Do NOT mention that multiple agents were used — present as one unified answer"""


async def _synthesize(task: str, agent_outputs: List[Dict],
                      url: str, model: str, headers: Optional[Dict]) -> str:
    """Combine all agent outputs into a final response."""
    parts = [f"# Original Task\n{task}\n"]
    for ao in agent_outputs:
        title = ao.get("title", f"Agent {ao['id']}")
        output = ao.get("output", "").strip() or "(no output)"
        parts.append(f"## {title}\n{output}")
    combined = "\n\n".join(parts)

    messages = [
        {"role": "system", "content": _SYNTH_SYSTEM},
        {"role": "user", "content": combined},
    ]
    return await _llm_complete(messages, url, model, headers, max_tokens=4096)


# ── SSE orchestration generator ───────────────────────────────────────────────

async def _run_job(job: Dict) -> None:
    """Full orchestration pipeline — updates job dict in place, no return value."""
    url, model, headers = _resolve_llm()
    if not url:
        job["status"] = "error"
        job["error"] = "No LLM endpoint configured in Odysseus."
        return

    task = job["task"]

    # Phase 1: plan
    job["status"] = "planning"
    try:
        subtasks = await _plan(task, url, model, headers)
    except Exception as e:
        job["status"] = "error"
        job["error"] = f"Planning failed: {e}"
        return

    job["subtasks"] = subtasks
    for st in subtasks:
        job["agents"][st["id"]] = {"status": "pending", "output": "", "title": st["title"]}

    # Phase 2: run all subtasks in parallel
    job["status"] = "running"
    queue: asyncio.Queue = asyncio.Queue()

    async def run_one(st: Dict):
        job["agents"][st["id"]]["status"] = "running"
        messages = [
            {"role": "user", "content": st["task"]},
        ]
        output = await _llm_stream_to_queue(
            messages, url, model, headers, queue, st["id"]
        )
        job["agents"][st["id"]]["output"] = output
        job["agents"][st["id"]]["status"] = "done"

    tasks = [asyncio.create_task(run_one(st)) for st in subtasks]

    # Drain queue until all subtasks complete
    done_count = 0
    while done_count < len(subtasks):
        try:
            event = await asyncio.wait_for(queue.get(), timeout=300)
        except asyncio.TimeoutError:
            logger.error("[subagent] Queue drain timeout")
            break
        if event["type"] in ("subtask_done", "subtask_error"):
            done_count += 1
        # Events are picked up by the SSE stream from job["_queue"]

    await asyncio.gather(*tasks, return_exceptions=True)

    # Phase 3: synthesize
    job["status"] = "synthesizing"
    agent_outputs = [
        {"id": st["id"], "title": st["title"], "output": job["agents"][st["id"]]["output"]}
        for st in subtasks
    ]
    try:
        result = await _synthesize(task, agent_outputs, url, model, headers)
    except Exception as e:
        result = f"(Synthesis failed: {e})\n\nRaw agent outputs:\n\n" + "\n\n---\n\n".join(
            f"**{ao['title']}**\n{ao['output']}" for ao in agent_outputs
        )

    job["result"] = result
    job["status"] = "done"
    job["finished_at"] = time.time()


# ── routes ────────────────────────────────────────────────────────────────────

def register_routes(app):
    import asyncio
    from fastapi import APIRouter, HTTPException, Request
    from fastapi.responses import StreamingResponse, JSONResponse
    from pydantic import BaseModel

    router = APIRouter(prefix="/pkgs/subagent")

    class RunRequest(BaseModel):
        task: str
        auto_parallelize: bool = True

    # ---------- POST /run (SSE stream) ----------

    @router.post("/run")
    async def run(req: RunRequest, request: Request):
        if not req.task.strip():
            raise HTTPException(400, "task cannot be empty")

        job = _new_job(req.task.strip())

        async def event_gen():
            yield _sse({"type": "job_created", "job_id": job["id"]})

            # Plan phase
            yield _sse({"type": "status", "status": "planning"})

            url, model, headers = _resolve_llm()
            if not url:
                yield _sse({"type": "error", "error": "No LLM endpoint configured."})
                return

            try:
                subtasks = await _plan(job["task"], url, model, headers)
            except Exception as e:
                yield _sse({"type": "error", "error": f"Planning failed: {e}"})
                return

            job["subtasks"] = subtasks
            for st in subtasks:
                job["agents"][st["id"]] = {
                    "status": "pending", "output": "", "title": st["title"]
                }
            yield _sse({"type": "plan", "subtasks": subtasks})

            # Run phase
            job["status"] = "running"
            yield _sse({"type": "status", "status": "running"})

            queue: asyncio.Queue = asyncio.Queue()

            async def run_one(st: Dict):
                job["agents"][st["id"]]["status"] = "running"
                yield _sse({"type": "agent_start", "id": st["id"], "title": st["title"]})
                messages = [{"role": "user", "content": st["task"]}]
                output = await _llm_stream_to_queue(
                    messages, url, model, headers, queue, st["id"]
                )
                job["agents"][st["id"]]["output"] = output
                job["agents"][st["id"]]["status"] = "done"

            # NOTE: We can't yield from coroutines launched via create_task.
            # Instead, drain the shared queue and forward events.
            parallel_tasks = [asyncio.create_task(_run_agent_task(st, job, queue)) for st in subtasks]

            done_count = 0
            while done_count < len(subtasks):
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=300)
                except asyncio.TimeoutError:
                    yield _sse({"type": "error", "error": "Agents timed out after 5 minutes."})
                    for t in parallel_tasks:
                        t.cancel()
                    return

                yield _sse(event)
                if event["type"] in ("subtask_done", "subtask_error"):
                    done_count += 1

            await asyncio.gather(*parallel_tasks, return_exceptions=True)

            # Synthesize
            job["status"] = "synthesizing"
            yield _sse({"type": "status", "status": "synthesizing"})

            agent_outputs = [
                {
                    "id": st["id"],
                    "title": st["title"],
                    "output": job["agents"][st["id"]]["output"],
                }
                for st in subtasks
            ]
            try:
                result_parts = []

                async def _synth_stream():
                    from src.llm_core import stream_llm
                    parts = [f"# Original Task\n{job['task']}\n"]
                    for ao in agent_outputs:
                        output = ao.get("output", "").strip() or "(no output)"
                        parts.append(f"## {ao['title']}\n{output}")
                    combined = "\n\n".join(parts)
                    messages = [
                        {"role": "system", "content": _SYNTH_SYSTEM},
                        {"role": "user",   "content": combined},
                    ]
                    async for chunk in stream_llm(url, model, messages, headers=headers, max_tokens=4096):
                        if not chunk.startswith("data:"):
                            continue
                        payload = chunk[5:].strip()
                        if payload == "[DONE]":
                            break
                        try:
                            d = json.loads(payload)
                            if "delta" in d and d["delta"]:
                                result_parts.append(d["delta"])
                                yield _sse({"type": "result_delta", "delta": d["delta"]})
                        except Exception:
                            pass

                async for ev in _synth_stream():
                    yield ev

            except Exception as e:
                yield _sse({"type": "result_delta", "delta": f"(Synthesis error: {e})"})

            result = "".join(result_parts)
            job["result"] = result
            job["status"] = "done"
            job["finished_at"] = time.time()
            yield _sse({"type": "done", "job_id": job["id"]})

        return StreamingResponse(event_gen(), media_type="text/event-stream")

    # ---------- POST /plan (planning only) ----------

    @router.post("/plan")
    async def plan_only(req: RunRequest):
        url, model, headers = _resolve_llm()
        if not url:
            raise HTTPException(503, "No LLM endpoint configured.")
        subtasks = await _plan(req.task.strip(), url, model, headers)
        return {"subtasks": subtasks}

    # ---------- GET /jobs ----------

    @router.get("/jobs")
    def list_jobs():
        jobs = sorted(_jobs.values(), key=lambda j: j["created_at"], reverse=True)
        return [_job_summary(j) for j in jobs[:20]]

    # ---------- GET /jobs/{jid} ----------

    @router.get("/jobs/{jid}")
    def get_job(jid: str):
        j = _jobs.get(jid)
        if not j:
            raise HTTPException(404, "Job not found")
        return j

    # ---------- DELETE /jobs/{jid} ----------

    @router.delete("/jobs/{jid}")
    def delete_job(jid: str):
        if jid in _jobs:
            del _jobs[jid]
        return {"status": "deleted"}

    app.include_router(router)
    logger.info("[subagent] Routes registered")


# ── helpers ───────────────────────────────────────────────────────────────────

def _sse(data: Any) -> str:
    return f"data: {json.dumps(data)}\n\n"


def _job_summary(j: Dict) -> Dict:
    return {
        "id": j["id"],
        "task": j["task"][:120],
        "status": j["status"],
        "agent_count": len(j["subtasks"]),
        "created_at": j["created_at"],
        "finished_at": j["finished_at"],
    }


async def _run_agent_task(st: Dict, job: Dict, queue: asyncio.Queue):
    """Run a single agent subtask; puts events on queue."""
    aid = st["id"]
    job["agents"][aid]["status"] = "running"
    await queue.put({"type": "agent_start", "id": aid, "title": st["title"]})
    messages = [{"role": "user", "content": st["task"]}]

    url, model, headers = _resolve_llm()
    if not url:
        await queue.put({"type": "subtask_error", "id": aid, "error": "No endpoint"})
        return

    output = await _llm_stream_to_queue(messages, url, model, headers, queue, aid)
    job["agents"][aid]["output"] = output
    job["agents"][aid]["status"] = "done"
