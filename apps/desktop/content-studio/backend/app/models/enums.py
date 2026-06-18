import enum


class ProjectStatus(str, enum.Enum):
    draft = "draft"
    generating = "generating"
    ready = "ready"
    failed = "failed"
    published = "published"


class ScriptStatus(str, enum.Enum):
    draft = "draft"
    generating = "generating"
    ready = "ready"
    failed = "failed"


class VideoStatus(str, enum.Enum):
    pending = "pending"
    rendering = "rendering"
    ready = "ready"
    uploaded = "uploaded"
    failed = "failed"


class JobStatus(str, enum.Enum):
    queued = "queued"
    running = "running"
    succeeded = "succeeded"
    failed = "failed"
    cancelled = "cancelled"


class JobType(str, enum.Enum):
    research = "research"
    script = "script"
    images = "images"
    audio = "audio"
    video = "video"
    publish = "publish"
    full_pipeline = "full_pipeline"


class ApiProvider(str, enum.Enum):
    openrouter = "openrouter"
    elevenlabs = "elevenlabs"
    stability = "stability"
    openai = "openai"
    local = "local"
    other = "other"


class SocialPlatform(str, enum.Enum):
    youtube = "youtube"
    tiktok = "tiktok"
    instagram = "instagram"
    x = "x"
    facebook = "facebook"
    linkedin = "linkedin"
    threads = "threads"


class SocialPostStatus(str, enum.Enum):
    draft = "draft"
    scheduled = "scheduled"
    publishing = "publishing"
    published = "published"
    failed = "failed"


class VideoType(str, enum.Enum):
    """Format + narrative style; drives pacing, scene budget, and renderer presets."""

    youtube_long_16_9 = "youtube_long_16_9"
    youtube_shorts_vertical = "youtube_shorts_vertical"
    documentary_voiceover = "documentary_voiceover"
    educational_explainer = "educational_explainer"
    commentary_opinion = "commentary_opinion"
    theory_narrative_engaging = "theory_narrative_engaging"
    cinematic_action_sequence = "cinematic_action_sequence"
    custom = "custom"
