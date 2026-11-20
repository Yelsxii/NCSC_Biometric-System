"""K14 LAN readiness: safe read-only network check and future sync seam.

This module DOES NOT implement a ZKTeco protocol or send attendance commands.
No biometric templates are handled. Import logic is shared with USB by using
the same punches schema; future firmware-compatible connector must be reviewed
before enabling actual synchronization.
"""
from __future__ import annotations

import ipaddress
import os
import socket
from dataclasses import dataclass


@dataclass(frozen=True)
class LanSettings:
    host: str
    port: int
    enabled: bool


def settings() -> LanSettings:
    host = os.getenv("K14_HOST", "192.168.1.201").strip()
    try:
        address = ipaddress.ip_address(host)
    except ValueError as exc:
        raise ValueError("K14_HOST must be a literal private IPv4 address.") from exc
    if address.version != 4 or not address.is_private or address.is_loopback or address.is_link_local:
        raise ValueError("K14_HOST must be a private, non-loopback IPv4 address.")
    port = int(os.getenv("K14_PORT", "4370"))
    if not 1 <= port <= 65535:
        raise ValueError("K14_PORT must be a valid TCP port.")
    enabled = os.getenv("K14_LAN_PROBE_ENABLED", "false").lower() == "true"
    return LanSettings(host, port, enabled)


def status() -> dict:
    cfg = settings()
    return {
        "host": cfg.host,
        "port": cfg.port,
        "probe_enabled": cfg.enabled,
        "sync_enabled": False,
        "mode": "USB import + LAN-ready architecture",
        "message": "LAN sync is not active. Enable an authorized network probe after wiring. "
                   "Actual data retrieval requires a validated read-only device SDK.",
    }


def tcp_probe() -> dict:
    """One opt-in TCP socket test, never a ZKTeco protocol operation.

    Port 4370 is often used by K14-family devices, but transport may be UDP;
    a TCP failure is INCONCLUSIVE and must not be treated as device failure.
    """
    cfg = settings()
    if not cfg.enabled:
        return {"reachable": None, "result": "disabled", "detail": "LAN test disabled until office authorizes it."}
    try:
        with socket.create_connection((cfg.host, cfg.port), timeout=1.5):
            return {"reachable": True, "result": "tcp_open", "detail": "TCP port is reachable; device protocol is not yet verified."}
    except (TimeoutError, ConnectionError, OSError):
        return {"reachable": False, "result": "tcp_unconfirmed", "detail": "No TCP handshake. Check cable/subnet; a UDP-only device may still work."}
