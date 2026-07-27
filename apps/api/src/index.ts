import type { Env } from "./types";
import { nearestImage, REGION_DEFS } from "./mapillary";
export { GameRoom } from "./GameRoom";

function resolveAllowedOrigin(env: Env, requestOrigin: string | null): string {
  const allowList = env.ALLOWED_ORIGIN.split(",").map((s) => s.trim());
  if (requestOrigin && allowList.includes(requestOrigin)) return requestOrigin;
  return allowList[0];
}

function corsHeaders(origin: string) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const headers = corsHeaders(resolveAllowedOrigin(env, req.headers.get("Origin")));

    if (req.method === "OPTIONS") {
      return new Response(null, { headers });
    }

    if (url.pathname === "/health") {
      return new Response("ok", { headers });
    }

    if (url.pathname === "/regions") {
      const list = Object.entries(REGION_DEFS).map(([key, def]) => ({ key, label: def.label }));
      return Response.json(list, { headers });
    }

    if (url.pathname === "/nearby-image") {
      const lat = Number(url.searchParams.get("lat"));
      const lng = Number(url.searchParams.get("lng"));
      if (Number.isNaN(lat) || Number.isNaN(lng)) {
        return new Response("invalid lat/lng", { status: 400, headers });
      }
      const result = await nearestImage(env.MAPILLARY_TOKEN, { lat, lng });
      return Response.json(result ?? { found: false }, { headers });
    }

    const match = url.pathname.match(/^\/room\/([^/]+)\/(start|stop|state|ws)$/);
    if (match) {
      const [, roomId] = match;
      const id = env.GAME_ROOM.idFromName(roomId);
      const stub = env.GAME_ROOM.get(id);
      const resp = await stub.fetch(req);

      if (resp.webSocket) return resp;

      const merged = new Headers(resp.headers);
      Object.entries(headers).forEach(([k, v]) => merged.set(k, v));
      return new Response(resp.body, { status: resp.status, headers: merged });
    }

    return new Response("not found", { status: 404, headers });
  },
};