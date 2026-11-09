"""Menu panel blueprint for wlanpi-menud browser UI."""

from flask import render_template, request

from wlanpi_webui.menu import bp
from wlanpi_webui.utils import is_htmx


@bp.route("/menu")
def menu():
    """Render the menu panel (HTMX partial or full page)."""
    if is_htmx(request):
        return render_template("/partials/menu.html")
    return render_template("/extends/menu.html")
