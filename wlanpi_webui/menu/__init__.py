from flask import Blueprint

bp = Blueprint("menu", __name__)

from wlanpi_webui.menu import menu  # noqa: E402, F401
