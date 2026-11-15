from .scenarios import router as scenarios_router
from .simulations import router as simulations_router
from .upload import router as upload_router
from .insights import router as insights_router
from .license import router as license_router, require_license

from .debug import router as debug_router
