import type { Env } from "./types";
import { nearestImage, REGION_DEFS } from "./mapillary";
export { GameRoom } from "./GameRoom";

const DEFAULT_ORIGIN = "http://localhost:5173";

function resolveAllowedOrigin(env: Env, requestOrigin: string | null): string {
  const allowList = (env.ALLOWED_ORIGIN ?? DEFAULT_ORIGIN)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (allowList.length === 0) return DEFAULT_ORIGIN;
  if (requestOrigin && allowList.includes(requestOrigin)) return requestOrigin;
  return allowList[0];
}

function corsHeaders(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const headers = corsHeaders(resolveAllowedOrigin(env, req.headers.get("Origin")));

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers });
    }

    if (url.pathname === "/health") {
      return Response.json(
        {
          ok: true,
          mapillaryToken: Boolean(env.MAPILLARY_TOKEN),
          db: Boolean(env.DB),
          kv: Boolean(env.SESSIONS),
          regions: Object.keys(REGION_DEFS).length,
        },
        { headers }
      );
    }

    if (url.pathname === "/regions") {
      const list = Object.entries(REGION_DEFS).map(([key, def]) => ({
        key,
        label: def.label,
        group: def.group,
      }));
      return Response.json(list, { headers: { ...headers, "Cache-Control": "public, max-age=3600" } });
    }

    if (url.pathname === "/nearby-image") {
      const q = url.searchParams;
      const lat = Number(q.get("lat"));
      const lng = Number(q.get("lng"));
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
        return Response.json({ found: false, error: "緯度経度が不正です" }, { status: 400, headers });
      }

      const panoOnly = q.get("pano") === "1";
      const carOnly = q.get("car") !== "0";
      const minKmRaw = Number(q.get("minKm"));

      const result = await nearestImage(env.MAPILLARY_TOKEN, { lat, lng }, {
        panoOnly,
        carOnly,
        excludeId: q.get("exclude") ?? undefined,
        excludeSequenceId: q.get("excludeSeq") ?? undefined,
        minKm: Number.isFinite(minKmRaw) ? Math.max(0, Math.min(5, minKmRaw)) : 0,
      });

      if (!result) {
        return Response.json(
          { found: false, error: "この付近に車から撮影された360°画像はありません" },
          { headers }
        );
      }

      return Response.json(
        {
          found: true,
          imageId: result.imageId,
          imageUrl: result.imageUrl,
          isPano: result.isPano,
          lat: result.point.lat,
          lng: result.point.lng,
          compassAngle: result.compassAngle ?? null,
          transport: result.transport ?? "unknown",
          point: result.point,
          sequenceId: result.sequenceId,
        },
        { headers }
      );
    }

    if (url.pathname === "/leaderboard") {
      const mode = url.searchParams.get("mode") === "classic" ? "classic" : "chase";
      try {
        const { results } = await env.DB.prepare(
          `SELECT total_score, region, rounds, finished_at
             FROM results WHERE mode = ?
            ORDER BY total_score DESC LIMIT 20`
        )
          .bind(mode)
          .all();
        return Response.json(results ?? [], { headers });
      } catch (err) {
        console.error("leaderboard query failed", err);
        return Response.json([], { headers });
      }
    }

    const match = url.pathname.match(/^\/room\/([A-Za-z0-9_-]{1,64})\/(start|stop|state|ws)$/);
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