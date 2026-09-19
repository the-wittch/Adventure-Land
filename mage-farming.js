// Adventure Land - Dynamic kite-farming mage (with chat-log diagnostics)
var attack_mode = true;

// ---- Tunables ----
var MAX_MONSTER_HP = 5000;   // skip higher-hp (boss) monsters
var ENGAGE_RANGE   = 700;    // only target monsters within this distance
var IGNORE_MTYPES  = ["rooster", "hen"]; // never fight/roam-to these (town chickens)
var PATH_MAX_ATT   = 150;  // absolute backstop: monsters attacking above this are path hazards
var PATH_RISK_PER_SEC = 0.15; // path hazard if their DPS exceeds 15% of my max HP per second
var TARGET_RISK_FRAC = 0.30;  // never pick a target whose DPS exceeds 30% of my max HP/s
var ROAM_RISK_FRAC  = 0.25;   // don't roam toward species above this DPS/maxHP ratio
var DANGER_PAD     = 60;   // clearance kept around dangerous monsters/zones while pathing
var STEER_STEP     = 44;   // hop size for danger-aware movement (px)
var BUY_AT_HPOT    = 20;
var BUY_AT_MPOT    = 20;
var BUY_TO          = 300;
var GOO_GOLD_GOAL  = 10000;    // once we have this much gold, try town again
var ROAM_MAX_ATT   = 150;  // when roaming, ignore species with attack above this
var ROAM_OTHER_RATIO = 2.5;// leave the current map only if another species scores 2.5x better
var ROAM_MAX_RESPAWN = 600; // ignore species that take longer than this (s) to respawn - jr (7.2h!) and spawn-once bosses aren't farmable
var ROAM_DELAY     = 8;      // seconds with no target before relocating
var ROAM_COOLDOWN  = 30;     // seconds between failed roam attempts (prevents spam)
var ACTION_INTERVAL = 110;   // ms between dispatched game actions (~9/s, under server cap)
var SHOP_FAIL_COOLDOWN = 60 * 1000; // ms to wait before retrying a failed town trip

// ---- Gear management policy (conservative) ----
var GEAR_ENABLED      = true;   // auto-equip strictly-better gear while in town
var KEEP_NAMES        = [];     // exact item names to keep carried, e.g. ["golden_poop"]
var BANK_NAMES        = [];     // exact item names to safe-store in the bank
var BANK_JUNK         = true;   // bank every other non-potion drop, so you can sell by hand
var BANK_MAX_ITEMS    = 900;    // stop banking once the bank holds this many slots
var BANK_FULL_SELL    = true;   // when the bank is full, sell junk-bin drops instead
var COMPOUND_TARGETS  = [];     // exact item names whose duplicates may be compounded
var COMPOUND_MAX_TIER = 3;      // maximal upgrade_level to auto-compound toward
var COMPOUND_FAIL_SKIP_MS = 60 * 60 * 1000; // back off failing compound requests
var ACTION_SKIP_MS    = 10 * 60 * 1000;     // remember failed equip/bank requests
// NOTE: potions (hpot/mpot/cpot/vpot) are ALWAYS exempt from compounding and
// banking - the script never moves or consumes them.

var returnPos = null;
var lowGold  = false;        // broke -> farm goo until we can afford pots
var shopping = false;        // currently on a potion-buying trip
var lastTarget = Date.now();
var lastRoam  = 0;           // timestamp of last roam attempt (cooldown)
var failedMaps = {};         // maps smart_move rejected; retried once stale (10 min)
var lastState = "";

// Town square on the mainland, just outside the bank door - the spot we retreat
// to before routing anywhere, so the bot never paths across maps from the bank.
var BANK_EXIT = { map: "mainland", x: 0, y: 0 };
var lastAction = 0;          // timestamp of the last game action dispatched
var lastAttack = 0;          // timestamp of the last attack dispatched
var attackBackoff = 0;       // extra ms between attacks; grows on server rejections
var cooldownRejects = 0;     // counters rejected cooldown attacks (logged every N)
var lastShopFail = 0;        // when the last town trip failed (retry cooldown)

function mark_failed_map(m) { if (m) failedMaps[m] = Date.now(); }

// Server kicks clients that spam game actions faster than ~10/s, so cap the rate.
function action_ready() {
    var now = Date.now();
    if (now - lastAction < ACTION_INTERVAL) return false;
    lastAction = now;
    return true;
}

// The server rejects attacks sent a few ms too early with reason "cool-down" /
// "cooldown". Those are routine (not errors) once the attack loop runs hot.
function is_cooldown_reject(e) {
    var m = String((e && (e.reason || e.message)) || "").toLowerCase().replace("-", "");
    return m.indexOf("cooldown") != -1;
}

// ---- Chat-log helper: only prints when the message changes ----
function note(msg, color) {
    if (msg == lastState) return;
    lastState = msg;
    game_log(msg, color || "#FFFFFF");
    set_message(msg);
}

// ---- Potion counting ----
function qty(names) {
    var n = 0;
    for (var i = 0; i < names.length; i++) n += quantity(names[i]);
    return n;
}
function hpot_count() { return qty(["hpot0", "hpot1", "hpot2"]); }
function mpot_count() { return qty(["mpot0", "mpot1", "mpot2"]); }

// ---- Monster helpers (monsters are in parent.entities) ----
function is_monster(e) {
    return e && e.type == "monster" && e.visible && !e.dead && e.hp > 0
        && (!e.map || e.map == character.map);
}

function is_junk(m) {
    if (IGNORE_MTYPES.indexOf(m.mtype) != -1) return true; // hard-ignored species
    if (m.mtype == "dummy") return true;                   // training dummies
    if (m.max_hp > MAX_MONSTER_HP) return true;            // bosses / tanky mobs
    return false;
}

function best_score_target() {
    var best = null, bestScore = 0;
    var nearest = null, nearestD = Infinity;
    for (var id in parent.entities) {
        var m = parent.entities[id];
        if (!is_monster(m) || is_junk(m) || too_risky_target(m)) continue;
        var d = parent.distance(character, m);
        if (d > ENGAGE_RANGE) continue;
        if (d < nearestD) { nearestD = d; nearest = m; }

        var xp  = Number(m.xp) || 0;
        var atk = Number(m.attack) || 0;
        var def = Number(m.defense) || 0;
        var hp  = Number(m.hp) || 1;
        var score = xp / (atk + def + hp / 100) / (1 + d / 300)
                  / (1 + risk_frac(m.mtype) * 3); // prefer targets we can out-sustain
        if (score > bestScore) { bestScore = score; best = m; }
    }
    return best || nearest; // fall back to closest valid monster
}

function pick_target() {
    if (lowGold) {
        var best = null, bestD = Infinity;
        for (var id in parent.entities) {
            var m = parent.entities[id];
            if (!is_monster(m) || m.mtype != "goo") continue;
            var d = parent.distance(character, m);
            if (d < bestD) { bestD = d; best = m; }
        }
        return best;
    }
    return best_score_target();
}

// ---- Cross-map roaming: score species globally, travel to the best spawn ----
function spawn_on_map(type, map) {
    var packs = (G.maps[map] && G.maps[map].monsters) || [];
    for (var i = 0; i < packs.length; i++) if (packs[i].type == type) return true;
    return false;
}

function available_species() {
    var set = {};
    for (var map in G.maps) {
        var gmap = G.maps[map];
        if (gmap.ignore || gmap.instance || gmap.pvp) continue;
        var packs = gmap.monsters || [];
        for (var i = 0; i < packs.length; i++) set[packs[i].type] = true;
    }
    return set;
}

function best_roam_species() {
    var avail = available_species();
    var bestLocal = null, bestGlobal = null;
    for (var type in avail) {
        if (type == "dummy") continue;
        if (IGNORE_MTYPES.indexOf(type) != -1) continue;
        var md = G.monsters[type];
        if (!md) continue;
        var hp  = Number(md.hp) || 0;
        var atk = Number(md.attack) || 0;
        var xp  = Number(md.xp) || 0;
        if (hp <= 0 || hp > MAX_MONSTER_HP) continue; // bosses
        if (atk > ROAM_MAX_ATT) continue;             // too dangerous
        if (is_lethal(type, ROAM_RISK_FRAC)) continue; // deadly for current level
        var rr = Number(md.respawn);
        if (!isNaN(rr) && (rr <= 0 || rr > ROAM_MAX_RESPAWN)) continue; // only respawns every 7.2h / once - not farmable
        var score = xp / (atk + hp / 100);
        if (spawn_on_map(type, character.map)) {
            if (!bestLocal || score > bestLocal.score) bestLocal = { type: type, score: score };
        }
        if (!bestGlobal || score > bestGlobal.score) bestGlobal = { type: type, score: score };
    }
    // Stay on this map whenever it has a farmable species. Only leave when the
    // best foreign species is clearly (ROAM_OTHER_RATIO x) more efficient, so
    // the character doesn't ping-pong between maps (travel is slow AND deadly).
    if (bestLocal) {
        if (!bestGlobal) return bestLocal.type;
        if (bestGlobal.score > bestLocal.score * ROAM_OTHER_RATIO) return bestGlobal.type;
        return bestLocal.type;
    }
    return bestGlobal ? bestGlobal.type : null;
}

function find_spawn(type) {
    var best = null, bestScore = -1;
    for (var map in G.maps) {
        var gmap = G.maps[map];
        if (gmap.ignore || gmap.instance || gmap.pvp || gmap.event) continue;
        if (failedMaps[map] && Date.now() - failedMaps[map] < 10 * 60 * 1000) continue;
        var packs = gmap.monsters || [];
        for (var i = 0; i < packs.length; i++) {
            var p = packs[i];
            if (p.type != type || !p.boundary) continue;
            var x = (p.boundary[0] + p.boundary[2]) / 2;
            var y = (p.boundary[1] + p.boundary[3]) / 2;
            var score = (Number(p.count) || 1) + (map == character.map ? 100 : 0);
            if (score > bestScore) { bestScore = score; best = { map: map, x: x, y: y }; }
        }
    }
    return best;
}

// ---- Leave the bank interior to the mainland before any long path ----
function leave_bank() {
    if (character.map != "bank") return Promise.resolve();
    if (typeof smart != "undefined" && smart.moving) return smart.moving; // already leaving
    note("Leaving the bank", "#FF8800");
    return smart_move({ to: BANK_EXIT.map, x: BANK_EXIT.x, y: BANK_EXIT.y })
        .catch(function (e) {
            game_log("Bank exit failed: " + (e && e.reason ? e.reason : e), "#FF3333");
        });
}

function roam() {
    if (shopping || smart.moving) return;
    if (Date.now() - lastRoam < ROAM_COOLDOWN * 1000) return; // silent, kills reject-spam
    lastRoam = Date.now();
    if (character.map == "bank") {
        // Never path from inside the bank - get to the mainland, then re-evaluate.
        note("Leaving the bank before roaming out", "#FF8800");
        leave_bank();
        return;
    }
    var type = lowGold ? "goo" : best_roam_species();
    if (!type) { note("No roam target found", "#FF5555"); return; }
    var spot = find_spawn(type);
    if (!spot) { note("No spawn for " + type, "#FF5555"); return; }
    if (!G.maps[spot.map]) { note("Skipping unknown map " + spot.map, "#FF5555"); return; }
    delete failedMaps[spot.map];
    note("Roaming to " + type + " on " + spot.map
         + " [" + Math.round(spot.x) + "," + Math.round(spot.y) + "]", "#AA66FF");
    var settle = function () {
        returnPos = { map: spot.map, x: spot.x, y: spot.y };
        if (character.map == spot.map) set_steer(spot.x, spot.y);
    };
    var walk = spot.map == character.map
        ? Promise.resolve()
        : smart_move({ to: spot.map }).then(function () {
              if (character.map == spot.map) set_steer(spot.x, spot.y);
          });
    walk.then(settle).catch(function (e) {
        mark_failed_map(spot.map);
        game_log("Roam failed: " + (e && e.reason ? e.reason : e), "#FF3333");
    });
}

// ---- Return to the saved farming spot ----
function go_back() {
    if (!returnPos) return Promise.resolve();
    var p = returnPos;
    returnPos = null;
    return leave_bank().then(function () {
        if (p.map == character.map) {
            set_steer(p.x, p.y);
            return;
        }
        return smart_move({ to: p.map }).then(function () {
            if (character.map == p.map) set_steer(p.x, p.y);
        }).catch(function (e) {
            game_log("Return failed: " + (e && e.reason ? e.reason : e), "#FF3333");
        });
    });
}

// ====================================================================
// Danger-aware pathing: instead of fighting through high-level monsters
// mid-travel, we steer around them. Every tick, while a steer goal is
// set, pick the walkable hop that keeps us clear of dangerous monsters
// (attack > PATH_MAX_ATT with aggro/charge) and their spawn zones.
// --------------------------------------------------------------------
var steerDest = null;   // { x, y } goal on the current map
var steerStuck = 0;     // consecutive ticks without a safe, walkable hop

function set_steer(x, y) { steerDest = { x: x, y: y }; steerStuck = 0; }

function steer_radius(type) {
    var md = G.monsters[type];
    if (!md) return DANGER_PAD;
    return Math.max(md.range || 0, md.charge || 0, 40) + DANGER_PAD;
}

// Monsters carry no "level", so threat is derived from their stats relative to
// the character: DPS = attack / frequency, then / max HP = fraction of our HP
// lost per second if we stand in it. That makes "dangerous" scale with level
// automatically instead of being a fixed flat threshold.
function monster_dps(type) {
    var md = G.monsters[type] || {};
    var freq = Number(md.frequency) || 1;
    return (Number(md.attack) || 0) / freq;
}

function risk_frac(type) {
    return monster_dps(type) / Math.max(1, character.max_hp);
}

// NOTE: monsters with no aggro/charge never chase, so they aren't hazards
// when merely passing by. minRisk is the fraction-of-maxHP-per-second gate.
function is_lethal(type, minRisk) {
    var md = G.monsters[type] || {};
    if ((Number(md.aggro) || 0) <= 0 && (Number(md.charge) || 0) <= 0) return false;
    if ((Number(md.attack) || 0) > PATH_MAX_ATT) return true;   // absolute backstop
    return risk_frac(type) >= minRisk;
}

function is_dangerous_type(type) {
    return is_lethal(type, PATH_RISK_PER_SEC);
}

function too_risky_target(m) {
    return m && m.mtype && is_lethal(m.mtype, TARGET_RISK_FRAC);
}

function point_in_danger(x, y) {
    // Visible dangerous monsters.
    for (var id in parent.entities) {
        var m = parent.entities[id];
        if (!m || m.type != "monster" || !is_dangerous_type(m.mtype)) continue;
        var dx = (x - (m.real_x != null ? m.real_x : m.x));
        var dy = (y - (m.real_y != null ? m.real_y : m.y));
        var r = steer_radius(m.mtype);
        if (dx * dx + dy * dy < r * r) return true;
    }
    // Known spawn zones on this map (covers monsters we haven't seen yet).
    var packs = (G.maps[character.map] && G.maps[character.map].monsters) || [];
    for (var k = 0; k < packs.length; k++) {
        var p = packs[k];
        if (!is_dangerous_type(p.type)) continue;
        var b = p.boundary;
        if (!b) continue;
        var px = Math.max(b[0] - x, 0, x - b[2]);
        var py = Math.max(b[1] - y, 0, y - b[3]);
        var r2 = steer_radius(p.type);
        if (px * px + py * py <= r2 * r2) return true;
    }
    return false;
}

// One hop toward steerDest; returns true when a move is pending.
function steer_tick() {
    if (!steerDest) return false;
    if (parent.distance(character, steerDest) <= STEER_STEP + 8) {
        steerDest = null;
        steerStuck = 0;
        return false; // arrived - normal logic resumes next tick
    }
    if (is_moving(character) || (typeof smart != "undefined" && smart.moving)) return true;

    // Emergency: low HP with a monster in reach - fight before moving on.
    if (character.hp < character.max_hp * 0.5) {
        var near = null, nd = Infinity;
        for (var eid in parent.entities) {
            var em = parent.entities[eid];
            if (!is_monster(em) || is_junk(em)) continue;
            var ed = parent.distance(character, em);
            if (ed > character.range) continue;
            if (ed < nd) { nd = ed; near = em; }
        }
        if (near) {
            attack_target(near);
            return true;
        }
    }

    var sx = character.real_x != null ? character.real_x : character.x;
    var sy = character.real_y != null ? character.real_y : character.y;
    var tx = steerDest.x - sx, ty = steerDest.y - sy;
    var len = Math.max(1, Math.sqrt(tx * tx + ty * ty));
    var ux = tx / len, uy = ty / len;

    var best = null, bestScore = -Infinity;
    var fallback = null, fallbackScore = -Infinity;
    for (var i = 0; i < 5; i++) {
        var ang = (i == 0) ? 0 : (i % 2 ? 1 : -1) * ((i + 1) / 2) * (Math.PI / 6);
        var c = Math.cos(ang), s = Math.sin(ang);
        var rx = ux * c - uy * s, ry = ux * s + uy * c; // rotate straight-ahead
        var cx = sx + rx * STEER_STEP, cy = sy + ry * STEER_STEP;
        if (!can_move_to(cx, cy)) continue;
        var prog = (cx - sx) * ux + (cy - sy) * uy;
        var lat = Math.abs((cx - sx) * uy - (cy - sy) * ux);
        var score = prog - lat; // straightest first, detours cost lateral distance
        if (prog <= 0) continue; // only advance toward the goal
        if (score > fallbackScore) { fallbackScore = score; fallback = { x: cx, y: cy }; }
        if (point_in_danger(cx, cy)) continue;
        if (score > bestScore) { bestScore = score; best = { x: cx, y: cy }; }
    }

    var hop = best || fallback;
    if (!hop) {
        // No walkable hop at all - give the in-game pathfinder one shot, then
        // let normal targeting resume.
        if (!smart.moving) {
            smart_move({ map: character.map, x: steerDest.x, y: steerDest.y }).catch(function () {});
        }
        steerDest = null;
        steerStuck = 0;
        return true;
    }
    if (!best && ++steerStuck > 8) { // safe route blocked; accept the risk
        if (!smart.moving) {
            smart_move({ map: character.map, x: steerDest.x, y: steerDest.y }).catch(function () {});
        }
        steerDest = null;
        steerStuck = 0;
        return true;
    }
    if (!action_ready()) return true; // throttle: wait for the next tick
    steerStuck = 0;
    xmove(hop.x, hop.y).catch(function () {});
    return true;
}

// While moving we only fight back in an emergency (low HP with a monster in
// reach) - the preference is to steer around danger, not fight through it.
function defend_on_the_way() {
    if (character.rip || shopping) return;
    if (character.hp > character.max_hp * 0.5) return;
    var t = null, bestD = Infinity;
    for (var id in parent.entities) {
        var m = parent.entities[id];
        if (!is_monster(m) || is_junk(m)) continue;
        var d = parent.distance(character, m);
        if (d > character.range) continue;
        if (d < bestD) { bestD = d; t = m; }
    }
    if (t) attack_target(t);
}

// ====================================================================
// Gear management: compound duplicates -> auto-equip better gear ->
// bank junk/valuables for manual selling. Runs inside the town restock
// trip so it never interrupts combat. All item operations are by
// inventory slot index (0-41), and each is gated by the shared action
// throttle to stay under the server's request cap. Potions are never
// touched.
// --------------------------------------------------------------------
var tidyPhase = 0;       // 0 compound, 1 equip, 2 bank
var tidyFinished = false;
var bankWalkFailed = false;
var shoppingStart = 0;   // when the current town trip began (safety timeout)
var skipCache = {};      // key -> timestamp of a failed/low-priority action

var POTION_PREFIXES = ["hpot", "mpot", "cpot", "vpot"];

function skip_cached(key) {
    return skipCache[key] && Date.now() - skipCache[key] < ACTION_SKIP_MS;
}

function is_potion(item) {
    if (!item || !item.name) return false;
    for (var i = 0; i < POTION_PREFIXES.length; i++)
        if (item.name.indexOf(POTION_PREFIXES[i]) == 0) return true;
    return false;
}

function is_keep(item) {
    return item && KEEP_NAMES.indexOf(item.name) != -1;
}

// Presence check (stackable materials carry q>0, so stacks must match too).
function has_item(name, excludeSlot) {
    for (var i = 0; i < character.items.length; i++) {
        if (i == excludeSlot) continue;
        var it = character.items[i];
        if (it && it.name == name) return true;
    }
    return false;
}

function item_level(it) {
    if (!it) return 0;
    if (it.level) return it.level;
    if (G.items[it.name]) return G.items[it.name].level || 0;
    return 0;
}

function tidy_done() {
    tidyFinished = true;
    tidyPhase = 0;
    return { done: true };
}

// Returns: a Promise for an action just started, a {done:true} sentinel,
// or null when there is nothing to do / the throttle is closed this tick.
function tidy_once() {
    // ---- Phase 0: compound duplicates (data-driven via G.items.compound) ----
    if (tidyPhase <= 0) {
        for (var a = 0; a < character.items.length; a++) {
            var ia = character.items[a];
            if (!ia || ia.q || ia.nquest || is_keep(ia) || is_potion(ia)) continue;
            if (COMPOUND_TARGETS.indexOf(ia.name) == -1) continue;
            var info = G.items[ia.name];
            if (!info || info.no_upgrade) continue;
            var lvl = ia.upgrade_level || 0;
            if (lvl >= COMPOUND_MAX_TIER) continue;
            var need = (info.compound && info.compound[lvl]) || [];
            if (!need.length) continue;
            var key = "compound|" + ia.name + "|" + lvl;
            if (skip_cached(key)) continue;
            for (var b = a + 1; b < character.items.length; b++) {
                var ib = character.items[b];
                if (!ib || ib.q || ib.nquest) continue;
                if (ib.name != ia.name || (ib.upgrade_level || 0) != lvl) continue;
                var matsOk = true;
                for (var k = 0; k < need.length && matsOk; k++) {
                    if (!has_item(need[k], a) && !has_item(need[k], b)) matsOk = false;
                }
                if (!matsOk) break;
                if (!action_ready()) return null;
                note("Compounding " + ia.name + " -> T" + (lvl + 1), "#FFAA00");
                return compound(a, b).catch(function (e) {
                    skipCache[key] = Date.now();
                    note("Compound failed: " + (e && e.reason ? e.reason : e), "#FF5555");
                });
            }
        }
        tidyPhase = 1;
    }

    // ---- Phase 1: auto-equip better gear ----
    if (tidyPhase == 1) {
        if (!GEAR_ENABLED || typeof find_equipment != "function") { tidyPhase = 2; }
        else {
            var equippedAny = false;
            for (var e = 0; e < character.items.length; e++) {
                var ie = character.items[e];
                if (!ie || ie.q || ie.nquest) continue;
                var slot = (G.items[ie.name] && G.items[ie.name].slot) || 0;
                if (!slot) continue;
                if (item_level(ie) > character.level) continue;
                var best;
                try { best = find_equipment(ie.name); } catch (err) { continue; }
                if (!best || best.name != ie.name) continue;
                if ((best.upgrade_level || 0) != (ie.upgrade_level || 0)) continue; // bank has a better copy
                var worn = character.slots[slot];
                if (worn && worn.name == ie.name && (worn.upgrade_level || 0) == (ie.upgrade_level || 0)) continue;
                var key = "equip|" + ie.name + "#" + (ie.upgrade_level || 0);
                if (skip_cached(key)) continue;
                if (!action_ready()) return null;
                note("Equipping " + ie.name + " (" + slot + ")", "#00FF00");
                equippedAny = true;
                return equip(e).catch(function (err) {
                    skipCache[key] = Date.now();
                    note("Equip failed: " + (err && err.reason ? err.reason : err), "#FF5555");
                });
            }
            if (!equippedAny) tidyPhase = 2;
        }
    }

    // ---- Phase 2: bank everything not kept (needs bank range) ----
    if (tidyPhase == 2) {
        if (bankWalkFailed) return tidy_done();
        if (!BANK_NAMES.length && !BANK_JUNK) return tidy_done();
        var bankFull = character.bank && character.bank.length >= BANK_MAX_ITEMS;
        var bi = null, sellMode = false;
        for (var s = 0; s < character.items.length; s++) {
            var is = character.items[s];
            if (!is || is.nquest || is_keep(is) || is_potion(is)) continue;
            if (skip_cached("bank|" + is.name)) continue; // failed before - skip it
            if (BANK_NAMES.indexOf(is.name) != -1) {
                if (bankFull) continue; // protected item but no room - keep carried
                bi = s; sellMode = false; break;
            }
            if (!BANK_JUNK || COMPOUND_TARGETS.indexOf(is.name) != -1) continue;
            if (bankFull && !BANK_FULL_SELL) continue; // full and not selling - leave it
            bi = s; sellMode = bankFull; break;        // junk bin: bank, or sell when full
        }
        if (bi === null) return tidy_done();
        if (!bankFull && !character.bank) {
            note("Walking to the bank", "#FF8800");
            return smart_move({ to: "bank" }).catch(function (e) {
                bankWalkFailed = true;
                game_log("Bank walk failed: " + (e && e.reason ? e.reason : e), "#FF3333");
                return null;
            });
        }
        if (!action_ready()) return null;
        if (sellMode) {
            note("Bank full - selling junk: " + character.items[bi].name, "#FF8800");
            return sell(bi).catch(function (e) {
                skipCache["bank|" + character.items[bi].name] = Date.now();
                note("Sell failed: " + (e && e.reason ? e.reason : e), "#FF5555");
            });
        }
        note("Banking " + character.items[bi].name, "#FF8800");
        return bank_store(bi).catch(function (e) {
            skipCache["bank|" + character.items[bi].name] = Date.now();
            note("Bank failed: " + (e && e.reason ? e.reason : e), "#FF5555");
        });
    }

    return null;
}

// Runs tidy phases back-to-back (one action each pass), waiting out the
// action throttle between passes, then heads back to the farming spot.
function tidy_loop(tries) {
    if (tidyFinished) return null;
    tries = tries || 0;
    var r = tidy_once();
    if (r && r.done) return null;
    if (r) return r.then(function () { return tidy_loop(0); }, function () { return tidy_loop(0); });
    if (tries > 40) { tidyFinished = true; return null; }
    return new Promise(function (resolve) {
        setTimeout(function () { resolve(tidy_loop(tries + 1)); }, ACTION_INTERVAL + 20);
    });
}

// ---- Walk to town: tidy gear first, then buy pots with gold, then return ----
function go_shopping() {
    if (shopping) return;
    if (Date.now() - lastShopFail < SHOP_FAIL_COOLDOWN) return; // back off after a failure
    shopping = true;
    shoppingStart = Date.now();
    tidyFinished = false;
    bankWalkFailed = false;
    tidyPhase = 0;
    skipCache = {};
    if (!returnPos && character.map) {
        returnPos = { map: character.map, x: character.x, y: character.y };
    }
    note("Pots low, going to town", "#FF8800");
    smart_move({ to: "potions" }).then(function () {
        // Tidy FIRST: compounding/equipping/banking clears inventory slots so the
        // potion purchase has room to land (fixes spammed "buy_cant_space").
        return tidy_loop();
    }).then(function () {
        // The bank phase may have walked us away; get back to the vendor.
        return smart_move({ to: "potions" });
    }).then(function () {
        var wantH = Math.max(0, BUY_TO - hpot_count());
        var wantM = Math.max(0, BUY_TO - mpot_count());
        return Promise.all([
            wantH ? buy_with_gold("hpot0", wantH) : null,
            wantM ? buy_with_gold("mpot0", wantM) : null
        ]);
    }).then(function () {
        game_log("Restocked: hpot=" + hpot_count() + " mpot=" + mpot_count()
                 + " gold=" + character.gold, "#00FF00");
        lowGold = (hpot_count() <= BUY_AT_HPOT || mpot_count() <= BUY_AT_MPOT);
        if (lowGold) game_log("Broke! Farming goo for gold", "#FF8800");
        return go_back(); // back to the farm spot, then end the trip
    }).then(function () {
        shopping = false;
    }).catch(function (e) {
        var reason = String((e && e.reason) || e || "");
        game_log("Shop trip failed: " + reason, "#FF3333");
        lastShopFail = Date.now();
        if (reason.indexOf("afford") != -1) lowGold = true; // goo-farm until affordable
        shopping = false;
        go_back();
    });
}

// ---- Mage burst, if the skill is available ----
function mage_burst(target) {
    try {
        if ((typeof can_use != "function" || can_use("burst"))
            && character.mp > (G.skills.burst.mp + character.max_mp * 0.3)
            && is_in_range(target, "burst")
            && !is_on_cooldown("burst")
            && action_ready()) {
            use_skill("burst").catch(function () {});
        }
    } catch (e) { /* skill not unlocked yet */ }
}

// Throttled basic attack shared by engage() and defend_on_the_way().
function attack_target(target) {
    if (!target || !is_in_range(target)) return false;
    if (can_attack(target)
        && Date.now() - lastAttack >= attackBackoff
        && action_ready()) {
        lastAttack = Date.now();
        note("Attacking " + target.mtype + " d=" + Math.round(parent.distance(character, target)),
             "#00FF00");
        attack(target).then(function () {
            reduce_cooldown("attack", character.ping * 0.95);
            attackBackoff = Math.max(ACTION_INTERVAL, attackBackoff - 50);
        }).catch(function (e) {
            if (is_cooldown_reject(e)) {
                // Sent a hair too early: widen the gap, don't flood the log.
                attackBackoff = Math.min(attackBackoff + 150, 1000);
                if (++cooldownRejects % 5 == 0)
                    note("Attack too early, backing off (" + Math.round(attackBackoff) + "ms)",
                         "#FFAA00");
            } else {
                attackBackoff = Math.max(ACTION_INTERVAL, attackBackoff - 50);
                note("Attack failed: " + (e && e.reason ? e.reason : e), "#FF5555");
            }
        });
        return true;
    }
    return false;
}

function engage(target) {
    var dist = parent.distance(character, target);
    var tooClose = Math.min(target.range + 25, character.range * 0.5);

    if (dist < tooClose) {
        var dx = character.real_x - target.x;
        var dy = character.real_y - target.y;
        var len = Math.sqrt(dx * dx + dy * dy);
        if (len < 1) { // stacked on the mob: pick any direction
            dx = Math.random() - 0.5;
            dy = Math.random() - 0.5;
            len = 1;
        }
        var step = Math.max(character.range * 0.5, 40);
        var base = Math.atan2(dy, dx);
        var found = false;
        // fan the retreat angle out a full circle so we never back straight into
        // water/walls; first walkable direction closest to straight-back wins
        for (var i = 0; i < 16; i++) {
            var ang = base + (i % 2 ? -1 : 1) * Math.ceil((i + 1) / 2) * (Math.PI / 12);
            var rx = character.real_x + Math.cos(ang) * step;
            var ry = character.real_y + Math.sin(ang) * step;
            if (can_move_to(rx, ry)) {
                if (action_ready()) {
                    note("Kiting " + target.mtype + " d=" + Math.round(dist), "#FFAA00");
                    move(rx, ry).catch(function () {});
                }
                found = true;
                break;
            }
        }
        if (found) return; // moving now, or will next tick once the throttle opens
        note("Boxed in, fighting in place", "#FFAA00"); // fall through to attack
    }

    if (is_in_range(target)) {
        attack_target(target);
        mage_burst(target);
        return;
    }

    note("Approaching " + target.mtype + " d=" + Math.round(dist), "#00AAFF");
    set_steer(target.x, target.y); // steer around dangerous monsters on the way
}

function tick() {
    use_hp_or_mp();
    loot();

    if (character.rip) { note("Dead, respawning...", "#FF0000"); return; }
    if (steer_tick()) return;   // danger-aware routing in progress
    if (is_moving(character) || (typeof smart != "undefined" && smart.moving)) {
        defend_on_the_way();
        return;
    }

    // Safety net: if a town/tidy trip ever hangs, force the way out.
    if (shopping && shoppingStart && Date.now() - shoppingStart > 5 * 60 * 1000) {
        game_log("Town trip timed out, heading back", "#FF8800");
        shopping = false;
        tidyFinished = true;
        go_back();
        return;
    }
    if (shopping) return;

    // ---- Restock (or goo farm when broke) ----
    if (hpot_count() <= BUY_AT_HPOT || mpot_count() <= BUY_AT_MPOT) {

        if (lowGold && character.gold >= GOO_GOLD_GOAL) {
            lowGold = false;
            note("Enough gold, going shopping", "#00FF00");
        }

        if (!lowGold) {
            go_shopping();
            return;
        }
        // lowGold: fall through and fight goo below
    }

    if (!attack_mode) { note("attack_mode is OFF", "#FF5555"); return; }

    var target = get_targeted_monster();
    if (!target || !target.visible || target.dead || target.hp <= 0 || is_junk(target)
        || too_risky_target(target)
        || parent.distance(character, target) > ENGAGE_RANGE) {
        target = pick_target();
        if (target) change_target(target);
    }

    if (!target) {
        note("No targets nearby", "#FF5555");
        if (Date.now() - lastTarget > ROAM_DELAY * 1000) {
            roam();
            lastTarget = Date.now();
        }
        return;
    }

    lastTarget = Date.now();
    var d = parent.distance(character, target);
    note("Target " + target.mtype + " hp=" + Math.round(target.hp)
         + " xp=" + target.xp + " d=" + Math.round(d), "#00FFFF");

    engage(target);
}

// Keep the browser from throttling JS when the tab loses focus
try { if (typeof performance_trick == "function") performance_trick(); } catch (e) {}

setInterval(function () {
    try {
        tick();
    } catch (e) {
        game_log("SCRIPT ERROR: " + (e && e.message ? e.message : e), "#FF3333");
    }
}, 1000 / 4);
