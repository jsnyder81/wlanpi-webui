"""Cockpit integration blueprint (deprecated).

The Cockpit plugin path is retired and replaced by the WebUI Menu plugin per
the FPMS Re-Architecture Plan.
"""

import warnings
from flask import redirect

from wlanpi_webui.auth.auth import csrf_required
from wlanpi_webui.cockpit import bp
from wlanpi_webui.utils import app_url, start_stop_service


@bp.route("/cockpit")
def cockpit():
    """Redirect to Cockpit (deprecated: WebUI Menu plugin replaces Cockpit)."""
    warnings.warn(
        "The Cockpit plugin route is deprecated; the WebUI Menu plugin replaces Cockpit "
        "per the FPMS Re-Architecture Plan.",
        DeprecationWarning,
        stacklevel=2,
    )
    return redirect(app_url(9090, "/app/cockpit/"))


@bp.route("/<task>cockpit", methods=["POST"])
@csrf_required
def start_stop_cockpit(task):
    """Start/stop cockpit service (deprecated)."""
    warnings.warn(
        "The Cockpit management route is deprecated; the WebUI Menu plugin replaces Cockpit "
        "per the FPMS Re-Architecture Plan.",
        DeprecationWarning,
        stacklevel=2,
    )
    return start_stop_service(task, "cockpit")
