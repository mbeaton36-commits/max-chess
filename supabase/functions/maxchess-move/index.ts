import { createClient } from "npm:@supabase/supabase-js@2.58.0";
import { Chess } from "npm:chess.js@1.4.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return reply({ error: "Use POST." }, 405);

  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return reply({ error: "Sign in first." }, 401);

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const publicKey = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!supabaseUrl || !publicKey || !serviceKey) {
    return reply({ error: "Server configuration is incomplete." }, 500);
  }

  const userClient = createClient(supabaseUrl, publicKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  // This privileged client stays inside the Edge Function. Its key is never sent
  // to the browser; it is used only after the caller and move have been validated.
  const serverClient = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  try {
    const token = authHeader.slice("Bearer ".length);
    const { data: userData, error: userError } = await userClient.auth.getUser(token);
    const user = userData?.user;
    if (userError || !user) return reply({ error: "Your sign-in has expired. Please log in again." }, 401);

    const body = await req.json();
    const gameId = String(body?.game_id ?? "");
    const from = String(body?.from ?? "");
    const to = String(body?.to ?? "");
    const promotion = body?.promotion == null ? undefined : String(body.promotion).toLowerCase();
    const expectedFen = String(body?.expected_fen ?? "");

    if (!/^[0-9a-f-]{36}$/i.test(gameId) || !/^[a-h][1-8]$/.test(from) || !/^[a-h][1-8]$/.test(to) ||
        (promotion !== undefined && !["q", "r", "b", "n"].includes(promotion)) || !expectedFen) {
      return reply({ error: "The move request is incomplete or invalid." }, 400);
    }

    const { data: row, error: readError } = await userClient
      .from("games")
      .select("id, white_player, black_player, fen, pgn, status")
      .eq("id", gameId)
      .maybeSingle();

    if (readError || !row) return reply({ error: "Game not found or you are not a player." }, 404);
    if (row.status !== "active") return reply({ error: "This game has already finished." }, 409);
    if (row.fen !== expectedFen) return reply({ error: "The board changed. Refreshing the latest position." }, 409);

    const isWhite = row.white_player === user.id;
    const isBlack = row.black_player === user.id;
    if (!isWhite && !isBlack) return reply({ error: "You are not a player in this game." }, 403);

    const chess = new Chess(row.fen);
    const expectedColor = chess.turn();
    if ((expectedColor === "w" && !isWhite) || (expectedColor === "b" && !isBlack)) {
      return reply({ error: "It is not your turn." }, 403);
    }

    let move;
    try {
      move = chess.move({ from, to, ...(promotion ? { promotion } : {}) });
    } catch {
      move = null;
    }
    if (!move) return reply({ error: "That is not a legal chess move." }, 400);

    let status = "active";
    if (chess.isCheckmate()) status = chess.turn() === "w" ? "black_won" : "white_won";
    else if (chess.isDraw()) status = "draw";

    const { data: saved, error: saveError } = await serverClient
      .from("games")
      .update({ fen: chess.fen(), pgn: chess.pgn(), status })
      .eq("id", gameId)
      .eq("fen", expectedFen)
      .eq("status", "active")
      .select("id, fen, pgn, status, updated_at")
      .maybeSingle();

    if (saveError) return reply({ error: saveError.message }, 400);
    if (!saved) return reply({ error: "Another move was saved first. Refresh the board." }, 409);

    return reply({ game: saved, move: { san: move.san, from: move.from, to: move.to } });
  } catch (error) {
    return reply({ error: error instanceof Error ? error.message : "Could not save the move." }, 400);
  }
});