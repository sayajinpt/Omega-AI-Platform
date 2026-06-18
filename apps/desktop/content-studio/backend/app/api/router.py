from fastapi import APIRouter

from app.api.routes import agent, auth, credentials, projects, schedules, series, social, youtube

api_router = APIRouter()
api_router.include_router(auth.router)
api_router.include_router(credentials.router)
api_router.include_router(agent.router)
api_router.include_router(projects.router)
api_router.include_router(series.router)
api_router.include_router(schedules.router)
api_router.include_router(social.router)
api_router.include_router(youtube.router)
