-- Only the trusted MaxChess move Edge Function may update game rows.
REVOKE UPDATE ON TABLE public.games FROM authenticated;

CREATE OR REPLACE FUNCTION public.guard_maxchess_game_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  old_turn text;
  new_turn text;
  old_fullmove integer;
  new_fullmove integer;
BEGIN
  IF NEW.white_player IS DISTINCT FROM OLD.white_player
     OR NEW.black_player IS DISTINCT FROM OLD.black_player THEN
    RAISE EXCEPTION 'Game players cannot be changed.';
  END IF;

  IF OLD.status <> 'active' THEN
    RAISE EXCEPTION 'This game is already finished.';
  END IF;

  IF current_setting('request.jwt.claim.role', true) = 'service_role' THEN
    NEW.updated_at := now();
    RETURN NEW;
  END IF;

  IF auth.uid() IS NULL OR auth.uid() NOT IN (OLD.white_player, OLD.black_player) THEN
    RAISE EXCEPTION 'Only a player in this game can move.';
  END IF;

  IF NEW.fen IS NOT DISTINCT FROM OLD.fen THEN
    RAISE EXCEPTION 'A move must change the board position.';
  END IF;

  old_turn := split_part(OLD.fen, ' ', 2);
  new_turn := split_part(NEW.fen, ' ', 2);
  IF old_turn NOT IN ('w', 'b') OR new_turn NOT IN ('w', 'b') OR new_turn = old_turn THEN
    RAISE EXCEPTION 'The move must pass the turn to the other player.';
  END IF;

  IF (old_turn = 'w' AND auth.uid() IS DISTINCT FROM OLD.white_player)
     OR (old_turn = 'b' AND auth.uid() IS DISTINCT FROM OLD.black_player) THEN
    RAISE EXCEPTION 'It is not your turn.';
  END IF;

  BEGIN
    old_fullmove := split_part(OLD.fen, ' ', 6)::integer;
    new_fullmove := split_part(NEW.fen, ' ', 6)::integer;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'Invalid board position.';
  END;

  IF old_fullmove IS NULL OR new_fullmove IS NULL
     OR (old_turn = 'w' AND new_fullmove <> old_fullmove)
     OR (old_turn = 'b' AND new_fullmove <> old_fullmove + 1) THEN
    RAISE EXCEPTION 'Invalid move counter.';
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;