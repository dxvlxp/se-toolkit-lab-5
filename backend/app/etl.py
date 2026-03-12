"""ETL pipeline: fetch data from the autochecker API and load it into the database.

The autochecker dashboard API provides two endpoints:
- GET /api/items — lab/task catalog
- GET /api/logs  — anonymized check results (supports ?since= and ?limit= params)

Both require HTTP Basic Auth (email + password from settings).
"""

from datetime import datetime

import httpx
from sqlalchemy import func
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.settings import settings


# ---------------------------------------------------------------------------
# Extract — fetch data from the autochecker API
# ---------------------------------------------------------------------------


async def fetch_items() -> list[dict]:
    """Fetch the lab/task catalog from the autochecker API."""
    url = f"{settings.autochecker_api_url}/api/items"

    async with httpx.AsyncClient() as client:
        response = await client.get(
            url,
            auth=(settings.autochecker_email, settings.autochecker_password),
        )

    response.raise_for_status()
    return response.json()


async def fetch_logs(since: datetime | None = None) -> list[dict]:
    """Fetch check results from the autochecker API."""
    url = f"{settings.autochecker_api_url}/api/logs"
    all_logs: list[dict] = []
    cursor = since

    async with httpx.AsyncClient() as client:
        while True:
            params: dict[str, str | int] = {"limit": 500}
            if cursor is not None:
                params["since"] = cursor.isoformat()

            response = await client.get(
                url,
                params=params,
                auth=(settings.autochecker_email, settings.autochecker_password),
            )
            response.raise_for_status()

            payload = response.json()
            batch = payload.get("logs", [])
            all_logs.extend(batch)

            if not payload.get("has_more") or not batch:
                break

            cursor = datetime.fromisoformat(batch[-1]["submitted_at"].replace("Z", "+00:00"))

    return all_logs


# ---------------------------------------------------------------------------
# Load — insert fetched data into the local database
# ---------------------------------------------------------------------------


async def load_items(items: list[dict], session: AsyncSession) -> int:
    """Load items (labs and tasks) into the database."""
    from app.models.item import ItemRecord

    created = 0
    labs_by_short_id: dict[str, ItemRecord] = {}

    for lab in [item for item in items if item.get("type") == "lab"]:
        title = lab["title"]
        statement = select(ItemRecord).where(
            ItemRecord.type == "lab",
            ItemRecord.title == title,
        )
        existing = (await session.exec(statement)).first()
        if existing is None:
            existing = ItemRecord(type="lab", title=title)
            session.add(existing)
            await session.flush()
            created += 1

        labs_by_short_id[lab["lab"]] = existing

    for task in [item for item in items if item.get("type") == "task"]:
        parent_lab = labs_by_short_id.get(task["lab"])
        if parent_lab is None:
            continue

        title = task["title"]
        statement = select(ItemRecord).where(
            ItemRecord.type == "task",
            ItemRecord.title == title,
            ItemRecord.parent_id == parent_lab.id,
        )
        existing = (await session.exec(statement)).first()
        if existing is None:
            existing = ItemRecord(type="task", title=title, parent_id=parent_lab.id)
            session.add(existing)
            await session.flush()
            created += 1

    await session.commit()
    return created


async def load_logs(
    logs: list[dict], items_catalog: list[dict], session: AsyncSession
) -> int:
    """Load interaction logs into the database.

    Args:
        logs: Raw log dicts from the API (each has lab, task, student_id, etc.)
        items_catalog: Raw item dicts from fetch_items() — needed to map
            short IDs (e.g. "lab-01", "setup") to item titles stored in the DB.
        session: Database session.
    """
    from app.models.interaction import InteractionLog
    from app.models.item import ItemRecord
    from app.models.learner import Learner

    created = 0
    item_title_by_short_ids: dict[tuple[str | None, str | None], str] = {}

    for item in items_catalog:
        if item.get("type") == "lab":
            item_title_by_short_ids[(item.get("lab"), None)] = item["title"]
        elif item.get("type") == "task":
            item_title_by_short_ids[(item.get("lab"), item.get("task"))] = item["title"]

    for log in logs:
        learner_statement = select(Learner).where(
            Learner.external_id == str(log["student_id"])
        )
        learner = (await session.exec(learner_statement)).first()
        if learner is None:
            learner = Learner(
                external_id=str(log["student_id"]),
                student_group=log.get("group", ""),
            )
            session.add(learner)
            await session.flush()

        title = item_title_by_short_ids.get((log.get("lab"), log.get("task")))
        if title is None and log.get("task") is None:
            title = item_title_by_short_ids.get((log.get("lab"), None))
        if title is None:
            continue

        item_statement = select(ItemRecord).where(ItemRecord.title == title)
        item = (await session.exec(item_statement)).first()
        if item is None:
            continue

        interaction_statement = select(InteractionLog).where(
            InteractionLog.external_id == int(log["id"])
        )
        existing_interaction = (await session.exec(interaction_statement)).first()
        if existing_interaction is not None:
            continue

        created_at = datetime.fromisoformat(log["submitted_at"].replace("Z", "+00:00"))
        interaction = InteractionLog(
            external_id=int(log["id"]),
            learner_id=learner.id,
            item_id=item.id,
            kind="attempt",
            score=log.get("score"),
            checks_passed=log.get("passed"),
            checks_total=log.get("total"),
            created_at=created_at,
        )
        session.add(interaction)
        created += 1

    await session.commit()
    return created


# ---------------------------------------------------------------------------
# Orchestrator
# ---------------------------------------------------------------------------


async def sync(session: AsyncSession) -> dict:
    """Run the full ETL pipeline."""
    from app.models.interaction import InteractionLog

    items_catalog = await fetch_items()
    await load_items(items_catalog, session)

    latest_statement = select(func.max(InteractionLog.created_at))
    since = (await session.exec(latest_statement)).one()

    logs = await fetch_logs(since=since)
    new_records = await load_logs(logs, items_catalog, session)

    total_statement = select(func.count()).select_from(InteractionLog)
    total_records = int((await session.exec(total_statement)).one())

    return {"new_records": new_records, "total_records": total_records}
