// Adventure Land - shared farming / town core.
// Load from a class script via load_code("common"), then call begin_farming({...}).
if (typeof COMMON_LOADED == "undefined") {
COMMON_LOADED = true;

var attack_mode = true;

// ---- Role / combat hooks (class scripts set these via begin_farming) ----
var ROLE = "farmer";          // "farmer" | "merchant"
var FARM_STYLE = "kite";      // "kite" | "melee"
var class_skills = null;      // function(target) — class skill burst
var class_engage = null;      // optional full engage override
var class_tick = null;        // optional full tick override (merchant)
var farmingStarted = false;

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
var GOO_GOLD_GOAL  = 0;      // 0 = auto (gold needed to buy BUY_TO of each pot); broke-mode exit
var ROAM_MAX_ATT   = 400;  // hard roam cap (risk_frac is the real gate; this only drops absurd bosses)
var ROAM_OTHER_RATIO = 1.6;// leave the current map if another species scores this much better
var ROAM_MAX_RESPAWN = 600; // ignore species that take longer than this (s) to respawn - jr (7.2h!) and spawn-once bosses aren't farmable
var ROAM_DELAY     = 8;      // seconds with no target before relocating
var ROAM_COOLDOWN  = 30;     // seconds between failed roam attempts (prevents spam)
var USE_PROGRESSION = true;  // bias toward get_progression() farm when the game exposes it
var TRIVIAL_HP_FRAC = 0.5;   // mob max_hp below character.attack * this is "too easy"
var ACTION_INTERVAL = 125;   // ms between dispatched game actions (~8/s, under server cap)
var SHOP_FAIL_COOLDOWN = 60 * 1000; // ms to wait before retrying a failed town trip

// ---- Gear management policy (conservative) ----
var GEAR_ENABLED      = true;   // auto-equip strictly-better gear while in town
var KEEP_NAMES        = [];     // exact item names to keep carried, e.g. ["golden_poop"]
var BANK_NAMES        = [];     // exact item names to safe-store in the bank
var BANK_JUNK         = true;   // bank every other non-potion drop, so you can sell by hand
var BANK_MAX_ITEMS    = 900;    // soft cap: also treat bank as full at this many occupied slots
var BANK_FULL_SELL    = true;   // when the bank is full, leave vault and sell junk at a vendor
var COMPOUND_TARGETS  = [];     // exact item names whose duplicates may be compounded
var COMPOUND_MAX_TIER = 3;      // max item.level to auto-compound toward
var COMPOUND_BUY_SCROLLS = true; // buy cscroll* with gold when a compound needs one
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
var lastBagTidy = 0;         // last town trip triggered by a full bag
var respawnQueued = false;   // avoid spamming respawn() during the death timer

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

// Sticky status for the UI only - avoids flooding game_log every tick when
// hp/distance flicker. Use note() for real state transitions.
function status(msg) {
    if (msg == lastState) return;
    lastState = msg;
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

function potion_unit_cost(name) {
    return (G.items[name] && Number(G.items[name].g)) || 20;
}

// Gold needed to top pots back up to BUY_TO (used for broke-mode exit).
function restock_gold_need() {
    var needH = Math.max(0, BUY_TO - hpot_count());
    var needM = Math.max(0, BUY_TO - mpot_count());
    return needH * potion_unit_cost("hpot0") + needM * potion_unit_cost("mpot0");
}

function goo_gold_goal() {
    if (GOO_GOLD_GOAL > 0) return GOO_GOLD_GOAL;
    // At least enough for a full restock, with a small buffer.
    return Math.max(500, restock_gold_need() + 100);
}

function can_afford_restock() {
    return character.gold >= restock_gold_need();
}

// Broke-mode should only stick while pots are low AND we cannot buy more.
function refresh_low_gold() {
    var potsLow = hpot_count() <= BUY_AT_HPOT || mpot_count() <= BUY_AT_MPOT;
    if (!potsLow) {
        if (lowGold) {
            lowGold = false;
            note("Potions OK - resuming normal farming", "#00FF00");
        }
        return;
    }
    if (lowGold && (character.gold >= goo_gold_goal() || can_afford_restock())) {
        lowGold = false;
        note("Can afford potions - leaving goo grind", "#00FF00");
    }
}

// ---- Monster helpers (monsters are in parent.entities) ----
function is_monster(e) {
    return e && e.type == "monster" && e.visible && !e.dead && e.hp > 0
        && (!e.map || e.map == character.map);
}

function monster_def(type) {
    return (type && G.monsters && G.monsters[type]) || {};
}

function is_junk(m) {
    if (!m || !m.mtype) return true;
    if (IGNORE_MTYPES.indexOf(m.mtype) != -1) return true; // hard-ignored species
    if (m.mtype == "dummy") return true;                   // training dummies
    var md = monster_def(m.mtype);
    var hp = Number(m.max_hp) || Number(md.hp) || 0;
    if (hp > MAX_MONSTER_HP) return true;                  // bosses / tanky mobs
    return false;
}

function our_dps() {
    var freq = Number(character.frequency) || 1;
    return Math.max(1, (Number(character.attack) || 1) * freq);
}

// Pull recommended farm mtypes from the in-game Progression Guide when present.
function recommended_farm_types() {
    var out = [], seen = {};
    function add(v) {
        if (!v) return;
        if (typeof v == "string") {
            if (G.monsters[v] && !seen[v]) { seen[v] = true; out.push(v); }
            return;
        }
        if (typeof v != "object") return;
        if (typeof v.monster == "string") add(v.monster);
        if (typeof v.mtype == "string") add(v.mtype);
        if (typeof v.type == "string") add(v.type);
        if (typeof v.farm == "string") add(v.farm);
        if (v.farm && typeof v.farm == "object") add(v.farm);
        if (Array.isArray(v.monsters)) for (var i = 0; i < v.monsters.length; i++) add(v.monsters[i]);
        if (Array.isArray(v)) for (var j = 0; j < v.length; j++) add(v[j]);
    }
    if (!USE_PROGRESSION) return out;
    try {
        if (typeof get_progression == "function") add(get_progression());
    } catch (e) { /* guide unavailable */ }
    return out;
}

// XP/hour-style score for a species vs our current attack/HP. Higher is better.
// Uses G.monsters (not live entity crumbs) so goo does not win just by being wounded/nearby.
function species_score(type, riskFrac) {
    var md = monster_def(type);
    if (!md || !Object.keys(md).length) return -1;
    if (type == "dummy" || IGNORE_MTYPES.indexOf(type) != -1) return -1;
    var hp  = Number(md.hp) || 0;
    var xp  = Number(md.xp) || 0;
    var atk = Number(md.attack) || 0;
    if (hp <= 0 || xp <= 0 || hp > MAX_MONSTER_HP) return -1;
    if (atk > ROAM_MAX_ATT) return -1;
    if (too_risky_type(type, riskFrac != null ? riskFrac : TARGET_RISK_FRAC))
        return -1;

    var rr = Number(md.respawn);
    if (!isNaN(rr) && (rr <= 0 || rr > ROAM_MAX_RESPAWN)) return -1;

    var killTime = hp / our_dps();                 // seconds to burn the pack member
    var xpRate = xp / Math.max(0.35, killTime);    // XP per second of fighting

    // Survivability: how many of us-die-times fit in one kill.
    var ttd = character.max_hp / Math.max(0.25, monster_dps(type));
    var sustain = ttd / Math.max(0.35, killTime);
    if (sustain < 1.2) xpRate *= 0.05;             // will melt - almost never pick
    else if (sustain < 2) xpRate *= 0.45;
    else if (sustain > 4) xpRate *= 1.15;          // comfortable farm

    // Soft-penalize trash we one-shot forever (classic "stuck on goo" case).
    if (hp < (Number(character.attack) || 1) * TRIVIAL_HP_FRAC) xpRate *= 0.25;
    // Mild preference for content near our punch weight.
    var hpRatio = hp / Math.max(1, Number(character.max_hp) || 1);
    if (hpRatio >= 0.15 && hpRatio <= 1.2) xpRate *= 1.25;

    var prog = recommended_farm_types();
    if (prog.indexOf(type) != -1) xpRate *= 2.75;

    return xpRate;
}

function best_score_target() {
    var best = null, bestScore = -1;
    var nearest = null, nearestD = Infinity;
    var prog = recommended_farm_types();
    for (var id in parent.entities) {
        var m = parent.entities[id];
        if (!is_monster(m) || is_junk(m) || too_risky_target(m)) continue;
        var d = parent.distance(character, m);
        if (d > ENGAGE_RANGE) continue;
        if (d < nearestD) { nearestD = d; nearest = m; }

        var score = species_score(m.mtype);
        if (score < 0) continue;
        // Prefer the guide monster when several options are close.
        if (prog.indexOf(m.mtype) != -1) score *= 1.15;
        score = score / (1 + d / 400);
        if (score > bestScore) { bestScore = score; best = m; }
    }
    return best || nearest; // fall back to closest valid monster
}

function nearest_mtype(type) {
    var best = null, bestD = Infinity;
    for (var id in parent.entities) {
        var m = parent.entities[id];
        if (!is_monster(m) || m.mtype != type) continue;
        var d = parent.distance(character, m);
        if (d < bestD) { bestD = d; best = m; }
    }
    return best;
}

function pick_target() {
    refresh_low_gold();
    // Broke-mode prefers goo for fast gold, but never idles if none are around.
    if (lowGold) {
        var goo = nearest_mtype("goo");
        if (goo) return goo;
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
    refresh_low_gold();
    var prog = recommended_farm_types();
    // If the Progression Guide names a farmable species, go there unless broke.
    if (!lowGold && prog.length) {
        for (var p = 0; p < prog.length; p++) {
            if (species_score(prog[p], ROAM_RISK_FRAC) > 0) return prog[p];
        }
    }

    var avail = available_species();
    var bestLocal = null, bestGlobal = null;
    for (var type in avail) {
        var score = species_score(type, ROAM_RISK_FRAC);
        if (score < 0) continue;
        // While broke, bias roam toward goo specifically.
        if (lowGold && type == "goo") score *= 3;
        if (spawn_on_map(type, character.map)) {
            if (!bestLocal || score > bestLocal.score) bestLocal = { type: type, score: score };
        }
        if (!bestGlobal || score > bestGlobal.score) bestGlobal = { type: type, score: score };
    }
    // Stay on this map whenever it has a farmable species. Only leave when the
    // best foreign species is clearly (ROAM_OTHER_RATIO x) more efficient, so
    // the character doesn't ping-pong between maps (travel is slow AND deadly).
    // Exception: if the best local farm is "trivial" goo-tier and a better
    // foreign species exists, leave at a lower bar so we do not park on goo.
    if (bestLocal) {
        if (!bestGlobal) return bestLocal.type;
        var leaveAt = ROAM_OTHER_RATIO;
        if (bestLocal.type == "goo" && bestGlobal.type != "goo") leaveAt = 1.15;
        if (bestGlobal.score > bestLocal.score * leaveAt) return bestGlobal.type;
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
    var md = monster_def(type);
    var freq = Number(md.frequency) || 1;
    return (Number(md.attack) || 0) / freq;
}

function risk_frac(type) {
    return monster_dps(type) / Math.max(1, character.max_hp);
}

// Pathing hazard: only aggro/charge packs, plus a high absolute attack backstop.
// Do NOT reuse this for fight targeting — it was wrongly excluding good farms.
function is_lethal_path(type) {
    var md = monster_def(type);
    if ((Number(md.aggro) || 0) <= 0 && (Number(md.charge) || 0) <= 0) return false;
    if ((Number(md.attack) || 0) > PATH_MAX_ATT) return true;
    return risk_frac(type) >= PATH_RISK_PER_SEC;
}

function is_dangerous_type(type) {
    return is_lethal_path(type);
}

// Fight targeting / roam: risk vs our HP only (and one-shot protection).
function too_risky_type(type, frac) {
    if (!type) return true;
    var md = monster_def(type);
    var atk = Number(md.attack) || 0;
    if (atk > character.max_hp * 0.5) return true; // probable one-shot
    return risk_frac(type) >= (frac != null ? frac : TARGET_RISK_FRAC);
}

function too_risky_target(m) {
    return m && m.mtype && too_risky_type(m.mtype, TARGET_RISK_FRAC);
}

// Kept for any older call sites / class scripts.
function is_lethal(type, minRisk) {
    if (minRisk == null || minRisk == PATH_RISK_PER_SEC) return is_lethal_path(type);
    return risk_frac(type) >= minRisk;
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
var bankKnownFull = false; // set when vault has no free slots or store is rejected
var shoppingStart = 0;   // when the current town trip began (safety timeout)
var skipCache = {};      // key -> timestamp of a failed/low-priority action

var POTION_PREFIXES = ["hpot", "mpot", "cpot", "vpot"];
var NON_GEAR_TYPES = {
    material: 1, pot: 1, cscroll: 1, uscroll: 1, pscroll: 1, token: 1,
    offering: 1, spawner: 1, essence: 1, standalone: 1, quest: 1, jar: 1,
    licence: 1, key: 1, gem: 1, misc: 1, throw: 1, skill_item: 1, box: 1
};

function skip_cached(key, ms) {
    return skipCache[key] && Date.now() - skipCache[key] < (ms || ACTION_SKIP_MS);
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
    // Adventure Land stores upgrade/compound tier on the instance as `level`.
    if (it.level != null) return Number(it.level) || 0;
    if (it.upgrade_level != null) return Number(it.upgrade_level) || 0; // legacy alias
    return 0;
}

function for_each_bank_pack(fn) {
    // character.bank is only populated on the bank map; packs are items0..itemsN.
    var bank = character.bank;
    if (!bank) return;
    for (var key in bank) {
        if (key.indexOf("items") != 0) continue;
        var pack = bank[key];
        if (!pack || typeof pack != "object") continue;
        fn(key, pack);
    }
}

function bank_item_count() {
    var n = 0;
    for_each_bank_pack(function (key, pack) {
        for (var i = 0; i < pack.length; i++) if (pack[i]) n++;
    });
    return n;
}

function bank_free_slots() {
    // -1 = bank UI not open (unknown). 0 = every unlocked pack slot is occupied.
    if (!character.bank) return -1;
    var free = 0, seen = 0;
    for_each_bank_pack(function (key, pack) {
        for (var i = 0; i < pack.length; i++) {
            seen++;
            if (!pack[i]) free++;
        }
    });
    if (!seen) return 0; // on bank map but no packs unlocked / visible
    return free;
}

function is_bank_full() {
    if (bankKnownFull) return true;
    if (!character.bank) return false;
    var free = bank_free_slots();
    if (free == 0) return true;
    if (bank_item_count() >= BANK_MAX_ITEMS) return true;
    return false;
}

function is_bank_space_reject(e) {
    var m = String((e && (e.reason || e.message)) || e || "").toLowerCase();
    return m.indexOf("full") != -1
        || m.indexOf("space") != -1
        || m.indexOf("no_space") != -1
        || m.indexOf("cant_store") != -1
        || m.indexOf("bank_store") != -1
        || (m.indexOf("bank") != -1 && m.indexOf("slot") != -1);
}

function for_each_bank_item(fn) {
    for_each_bank_pack(function (key, pack) {
        for (var i = 0; i < pack.length; i++) {
            if (pack[i]) fn(pack[i]);
        }
    });
}

// Leave the vault and walk to a buyback vendor before selling — sell() does
// nothing useful inside the bank map.
function go_sell_vendor() {
    note("Bank full - heading to vendor to sell junk", "#FF8800");
    var leave = character.map == "bank" ? leave_bank() : Promise.resolve();
    return leave.then(function () {
        return smart_move({ to: "potions" });
    });
}

function find_scroll_slot(name) {
    for (var i = 0; i < character.items.length; i++) {
        var it = character.items[i];
        if (it && it.name == name) return i;
    }
    return -1;
}

function compound_scroll_for(lvl) {
    // Standard AL scroll tiers for compounding accessories/rings/etc.
    if (lvl >= 7) return "cscroll3";
    if (lvl >= 4) return "cscroll2";
    if (lvl >= 2) return "cscroll1";
    return "cscroll0";
}

// ---- Equipment helpers ----
function item_info(name) { return (name && G.items[name]) || null; }

function slots_for_item(name) {
    var info = item_info(name);
    if (!info || !info.type || NON_GEAR_TYPES[info.type]) return [];
    var t = info.type;
    if (t == "ring") return ["ring1", "ring2"];
    if (t == "earring") return ["earring1", "earring2"];
    if (t == "weapon") return ["mainhand"];
    if (t == "shield" || t == "source" || t == "misc_offhand" || t == "quiver")
        return ["offhand"];
    if (t == "helmet" || t == "chest" || t == "pants" || t == "shoes"
        || t == "gloves" || t == "cape" || t == "belt" || t == "amulet"
        || t == "orb" || t == "elixir") return [t];
    return [];
}

function list_has(list, value) {
    if (!list) return false;
    if (Array.isArray(list)) return list.indexOf(value) != -1;
    if (typeof list == "object") return !!list[value];
    return list == value;
}

function can_wear(name) {
    var info = item_info(name);
    if (!info || !slots_for_item(name).length) return false;
    if (info.class && !list_has(info.class, character.ctype)) return false;
    var cdef = (G.classes && G.classes[character.ctype]) || {};
    if (info.type == "weapon") {
        var mh = cdef.mainhand || cdef.main_hand;
        if (mh && info.wtype && !list_has(mh, info.wtype)) return false;
    }
    if (info.type == "shield" || info.type == "source"
        || info.type == "misc_offhand" || info.type == "quiver") {
        var oh = cdef.offhand || cdef.off_hand;
        if (oh && Object.keys(oh).length) {
            var key = info.wtype || info.type;
            if (!list_has(oh, key) && !list_has(oh, info.type)) return false;
        }
    }
    return true;
}

function item_props(it) {
    if (!it || !it.name) return {};
    try {
        if (typeof calculate_item_properties == "function")
            return calculate_item_properties(it) || {};
        if (typeof parent != "undefined"
            && typeof parent.calculate_item_properties == "function")
            return parent.calculate_item_properties(it) || {};
    } catch (e) { /* fall through */ }
    // Fallback: base definition plus a flat per-level bump so +N still ranks higher.
    var base = item_info(it.name) || {};
    var props = {};
    for (var k in base) {
        if (typeof base[k] == "number") props[k] = base[k];
    }
    var lvl = item_level(it);
    if (lvl && props.attack) props.attack += lvl;
    if (lvl && props.armor) props.armor += lvl;
    if (lvl && props.resistance) props.resistance += lvl;
    if (lvl && props.int) props.int += lvl;
    if (lvl && props.str) props.str += lvl;
    if (lvl && props.dex) props.dex += lvl;
    if (lvl && props.vit) props.vit += lvl;
    props._level = lvl;
    return props;
}

// Class-aware gear score. Strictly higher score => worth equipping.
function item_score(it) {
    if (!it) return -Infinity;
    var p = item_props(it);
    var s = 0;
    s += (Number(p.hp) || 0) * 0.05;
    s += (Number(p.mp) || 0) * 0.12;
    s += (Number(p.armor) || 0);
    s += (Number(p.resistance) || 0);
    s += (Number(p.attack) || 0) * 2.2;
    s += (Number(p.range) || 0) * 3;
    s += (Number(p.frequency) || 0) * 50;
    s += (Number(p.speed) || 0) * 0.4;
    s += (Number(p.evasion) || 0) * 2;
    s += (Number(p.reflection) || 0) * 2;
    s += (Number(p.lifesteal) || 0) * 2;
    s += (Number(p.apiercing) || 0);
    s += (Number(p.rpiercing) || 0);
    s += (Number(p.crit) || 0) * 4;
    s += (Number(p.critdamage) || 0);
    s += (Number(p.xp) || 0) * 2;
    s += (Number(p.gold) || 0) * 2;
    var ctype = character.ctype;
    if (ctype == "mage" || ctype == "priest") {
        s += (Number(p.int) || 0) * 3.5;
        s += (Number(p.vit) || 0);
    } else if (ctype == "ranger" || ctype == "rogue") {
        s += (Number(p.dex) || 0) * 3.5;
        s += (Number(p.vit) || 0);
    } else {
        s += (Number(p.str) || 0) * 3.5;
        s += (Number(p.vit) || 0);
    }
    s += item_level(it) * 12; // tie-break / props-missing safety
    return s;
}

// Best owned copy of `name` across inventory, open bank packs, and equipped slots.
// Equip code only wears an inventory copy when it matches this result's level, so
// a stronger banked duplicate is never overwritten by a weaker carried one.
function find_equipment(name) {
    if (!name) return null;
    var best = null, bestLvl = -1;
    function consider(it) {
        if (!it || it.name != name) return;
        var lvl = item_level(it);
        if (lvl > bestLvl) { bestLvl = lvl; best = it; }
    }
    for (var i = 0; i < character.items.length; i++) consider(character.items[i]);
    for_each_bank_item(consider);
    for (var sn in character.slots) consider(character.slots[sn]);
    return best;
}

// Returns a slot name to equip into, or null when nothing worn is worse.
function equip_slot_for(it) {
    if (!it || !can_wear(it.name)) return null;
    var slots = slots_for_item(it.name);
    if (!slots.length) return null;
    var score = item_score(it);
    var empty = null;
    var worstSlot = null, worstScore = Infinity;
    for (var i = 0; i < slots.length; i++) {
        var sn = slots[i];
        var worn = character.slots[sn];
        if (!worn) { empty = sn; break; }
        // Already wearing this exact upgrade - nothing to do.
        if (worn.name == it.name && item_level(worn) >= item_level(it)) continue;
        var ws = item_score(worn);
        if (ws < worstScore) { worstScore = ws; worstSlot = sn; }
    }
    if (empty) return empty;
    if (worstSlot != null && score > worstScore) return worstSlot;
    return null;
}

function tidy_done() {
    tidyFinished = true;
    tidyPhase = 0;
    return { done: true };
}

// Returns: a Promise for an action just started, a {done:true} sentinel,
// or null when there is nothing to do / the throttle is closed this tick.
function tidy_once() {
    // ---- Phase 0: compound duplicates (needs 3 identical items + cscroll) ----
    if (tidyPhase <= 0) {
        for (var a = 0; a < character.items.length; a++) {
            var ia = character.items[a];
            if (!ia || ia.q || ia.nquest || is_keep(ia) || is_potion(ia)) continue;
            if (COMPOUND_TARGETS.indexOf(ia.name) == -1) continue;
            var info = G.items[ia.name];
            // Compoundables expose a `compound` stat table; skip pure upgrade gear.
            if (!info || !info.compound || info.no_upgrade) continue;
            var lvl = item_level(ia);
            if (lvl >= COMPOUND_MAX_TIER) continue;
            var key = "compound|" + ia.name + "|" + lvl;
            if (skip_cached(key, COMPOUND_FAIL_SKIP_MS)) continue;
            var slots = [a];
            for (var b = a + 1; b < character.items.length && slots.length < 3; b++) {
                var ib = character.items[b];
                if (!ib || ib.q || ib.nquest) continue;
                if (ib.name != ia.name || item_level(ib) != lvl) continue;
                slots.push(b);
            }
            if (slots.length < 3) continue;
            var scrollName = compound_scroll_for(lvl);
            var scrollSlot = find_scroll_slot(scrollName);
            if (scrollSlot < 0) {
                if (!COMPOUND_BUY_SCROLLS) continue;
                // Scrolls are sold by the scrolls NPC, not the potion vendor.
                note("Buying " + scrollName + " for compound", "#FFAA00");
                return smart_move({ to: "scrolls" }).then(function () {
                    return buy_with_gold(scrollName, 1);
                }).catch(function (e) {
                    skipCache[key] = Date.now();
                    note("Scroll buy failed: " + (e && e.reason ? e.reason : e), "#FF5555");
                });
            }
            if (!action_ready()) return null;
            note("Compounding " + ia.name + " -> +" + (lvl + 1), "#FFAA00");
            return compound(slots[0], slots[1], slots[2], scrollSlot).catch(function (e) {
                skipCache[key] = Date.now();
                note("Compound failed: " + (e && e.reason ? e.reason : e), "#FF5555");
            });
        }
        tidyPhase = 1;
    }

    // ---- Phase 1: auto-equip strictly-better wearable gear ----
    if (tidyPhase == 1) {
        if (!GEAR_ENABLED) { tidyPhase = 2; }
        else {
            var equippedAny = false;
            for (var e = 0; e < character.items.length; e++) {
                var ie = character.items[e];
                if (!ie || ie.q || ie.nquest || is_potion(ie) || is_keep(ie)) continue;
                if (!can_wear(ie.name)) continue;
                // Only equip this copy if we don't own a higher-level one (e.g. in bank).
                var best = find_equipment(ie.name);
                if (!best || best.name != ie.name) continue;
                if (item_level(best) != item_level(ie)) continue;
                var slotName = equip_slot_for(ie);
                if (!slotName) continue;
                var key = "equip|" + ie.name + "#" + item_level(ie) + "|" + slotName;
                if (skip_cached(key)) continue;
                if (!action_ready()) return null;
                note("Equipping " + ie.name + " +" + item_level(ie) + " -> " + slotName, "#00FF00");
                equippedAny = true;
                return equip(e, slotName).catch(function (err) {
                    skipCache[key] = Date.now();
                    note("Equip failed: " + (err && err.reason ? err.reason : err), "#FF5555");
                });
            }
            if (!equippedAny) tidyPhase = 2;
        }
    }

    // ---- Phase 2: bank valuables/junk; if the vault is full, sell junk in town ----
    if (tidyPhase == 2) {
        if (bankWalkFailed) return tidy_done();
        if (!BANK_NAMES.length && !BANK_JUNK) return tidy_done();

        // Discover real fullness as soon as the bank UI is open.
        if (character.bank && bank_free_slots() == 0) bankKnownFull = true;
        var bankFull = is_bank_full();

        var bi = null, sellMode = false;
        for (var s = 0; s < character.items.length; s++) {
            var is = character.items[s];
            if (!is || is.nquest || is_keep(is) || is_potion(is)) continue;
            if (skip_cached("bank|" + is.name) || skip_cached("sell|" + is.name)) continue;

            var protected = BANK_NAMES.indexOf(is.name) != -1;
            var compoundable = COMPOUND_TARGETS.indexOf(is.name) != -1;

            if (protected) {
                if (bankFull) continue; // keep carried until there is vault room
                bi = s; sellMode = false; break;
            }
            if (!BANK_JUNK) continue;
            // Hold compound fodder for later trips unless the vault is full — then
            // clear the bag so potions can still be bought.
            if (compoundable && !bankFull) continue;
            if (bankFull && !BANK_FULL_SELL) continue;
            bi = s; sellMode = bankFull; break;
        }
        if (bi === null) {
            if (bankFull && BANK_FULL_SELL)
                note("Bank full - inventory cleared of sellable junk", "#FFAA00");
            return tidy_done();
        }

        // Still need to visit the vault once to store items / learn it is full.
        if (!sellMode && !character.bank) {
            note("Walking to the bank", "#FF8800");
            return smart_move({ to: "bank" }).catch(function (e) {
                bankWalkFailed = true;
                game_log("Bank walk failed: " + (e && e.reason ? e.reason : e), "#FF3333");
                return null;
            });
        }

        // Selling must happen at a town vendor, never inside the bank map.
        if (sellMode) {
            if (character.map == "bank") {
                return go_sell_vendor().catch(function (e) {
                    bankWalkFailed = true;
                    game_log("Vendor path failed: " + (e && e.reason ? e.reason : e), "#FF3333");
                    return null;
                });
            }
            if (!action_ready()) return null;
            var sellName = character.items[bi] && character.items[bi].name;
            note("Bank full - selling junk: " + sellName, "#FF8800");
            return sell(bi).catch(function (e) {
                var reason = String((e && (e.reason || e.message)) || e || "").toLowerCase();
                // Wrong map / no NPC — walk to potions and retry next pass.
                if (reason.indexOf("distance") != -1 || reason.indexOf("nearby") != -1
                    || reason.indexOf("range") != -1 || reason.indexOf("npc") != -1
                    || reason.indexOf("merchant") != -1) {
                    return go_sell_vendor();
                }
                skipCache["sell|" + sellName] = Date.now();
                note("Sell failed: " + (e && e.reason ? e.reason : e), "#FF5555");
            });
        }

        if (!action_ready()) return null;
        var storeName = character.items[bi] && character.items[bi].name;
        note("Banking " + storeName, "#FF8800");
        return bank_store(bi).catch(function (e) {
            if (is_bank_space_reject(e)) {
                bankKnownFull = true;
                note("Bank is full - will sell junk at a vendor", "#FFAA00");
                return null; // next tidy_once pass switches to sellMode
            }
            skipCache["bank|" + storeName] = Date.now();
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
    // Allow a full bag of sells (42) plus throttle waits / vendor walks.
    if (tries > 120) {
        game_log("Tidy timed out - continuing trip", "#FFAA00");
        tidyFinished = true;
        return null;
    }
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
    bankKnownFull = false;
    tidyPhase = 0;
    skipCache = {};
    if (!returnPos && character.map) {
        returnPos = { map: character.map, x: character.x, y: character.y };
    }
    var townWhy = (typeof character.esize == "number" && character.esize <= 2)
        ? "Bag full, going to town"
        : "Pots low, going to town";
    note(townWhy, "#FF8800");
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
        var potsLow = hpot_count() <= BUY_AT_HPOT || mpot_count() <= BUY_AT_MPOT;
        // Only enter goo-grind when pots are still low AND we cannot pay for a restock.
        lowGold = potsLow && !can_afford_restock();
        if (lowGold) {
            if (ROLE == "merchant")
                game_log("Broke! Merchant waiting for gold", "#FF8800");
            else
                game_log("Broke! Farming goo for gold (need ~"
                         + Math.round(goo_gold_goal()) + ")", "#FF8800");
        } else if (potsLow) {
            game_log("Pots still low but gold OK - will retry shop later", "#FFAA00");
        }
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

// Safe skill attempt: respects MP reserve, cooldown, range, and action throttle.
function try_skill(name, target, mpReserveFrac) {
    try {
        if (!name || !G.skills || !G.skills[name]) return false;
        if (typeof can_use == "function" && !can_use(name)) return false;
        if (typeof is_on_cooldown == "function" && is_on_cooldown(name)) return false;
        var need = Number(G.skills[name].mp) || 0;
        var reserve = character.max_mp * (mpReserveFrac != null ? mpReserveFrac : 0.2);
        if (character.mp < need + reserve) return false;
        if (target && typeof is_in_range == "function" && !is_in_range(target, name))
            return false;
        if (!action_ready()) return false;
        if (target) use_skill(name, target).catch(function () {});
        else use_skill(name).catch(function () {});
        return true;
    } catch (e) {
        return false;
    }
}

// Throttled basic attack shared by engage() and defend_on_the_way().
function attack_target(target) {
    if (!target || !is_in_range(target)) return false;
    if (can_attack(target)
        && Date.now() - lastAttack >= attackBackoff
        && action_ready()) {
        lastAttack = Date.now();
        status("Attacking " + target.mtype);
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

function fire_class_skills(target) {
    if (typeof class_skills == "function") {
        try { class_skills(target); } catch (e) { /* skill kit error */ }
    }
}

// Ranged kite: keep distance, attack when in range.
function engage_kite(target) {
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
                    status("Kiting " + target.mtype);
                    xmove(rx, ry).catch(function () {});
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
        fire_class_skills(target);
        return;
    }

    status("Approaching " + target.mtype);
    set_steer(target.x, target.y); // steer around dangerous monsters on the way
}

// Melee stick: close to attack range and stay on the target (no kiting out).
function engage_melee(target) {
    if (is_in_range(target)) {
        attack_target(target);
        fire_class_skills(target);
        return;
    }
    status("Approaching " + target.mtype);
    set_steer(target.x, target.y);
}

function engage(target) {
    if (typeof class_engage == "function") {
        try { class_engage(target); } catch (e) {
            game_log("engage error: " + (e && e.message ? e.message : e), "#FF3333");
        }
        return;
    }
    if (FARM_STYLE == "melee") engage_melee(target);
    else engage_kite(target);
}

function maybe_restock() {
    refresh_low_gold();
    var bagTight = (typeof character.esize == "number" && character.esize <= 2
                    && Date.now() - lastBagTidy > SHOP_FAIL_COOLDOWN);
    var potsLow = hpot_count() <= BUY_AT_HPOT || mpot_count() <= BUY_AT_MPOT;
    if (!(potsLow || bagTight)) return false;

    if (lowGold && (character.gold >= goo_gold_goal() || can_afford_restock())) {
        lowGold = false;
        note("Enough gold, going shopping", "#00FF00");
    }

    // Merchants never goo-farm; farmers may fall through while broke.
    if (ROLE == "merchant") {
        if (bagTight && !potsLow) lastBagTidy = Date.now();
        go_shopping();
        return true;
    }

    if (!lowGold) {
        if (bagTight && !potsLow) {
            lastBagTidy = Date.now();
            note("Bag full, tidying in town", "#FF8800");
        }
        go_shopping();
        return true;
    }
    return false; // lowGold farmer: keep fighting goo
}

function tick() {
    use_hp_or_mp();
    loot();

    if (character.rip) {
        note("Dead, respawning...", "#FF0000");
        // Death has a ~12s server timer; one delayed call avoids reject spam.
        if (!respawnQueued) {
            respawnQueued = true;
            setTimeout(function () {
                respawnQueued = false;
                if (character.rip) respawn().catch(function () {});
            }, 15000);
        }
        return;
    }
    respawnQueued = false;

    // Class-provided full tick (merchant hangout, etc.)
    if (typeof class_tick == "function") {
        try { class_tick(); } catch (e) {
            game_log("tick error: " + (e && e.message ? e.message : e), "#FF3333");
        }
        return;
    }

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

    if (maybe_restock()) return;

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
    status("Target " + target.mtype);
    engage(target);
}

// Start the shared loop. Class scripts call this after load_code("common").
// opts: { role, style, skills, engage, tick }
function begin_farming(opts) {
    if (farmingStarted) {
        game_log("begin_farming: already running", "#FFAA00");
        return;
    }
    opts = opts || {};
    if (opts.role) ROLE = opts.role;
    if (opts.style) FARM_STYLE = opts.style;
    if (opts.skills) class_skills = opts.skills;
    if (opts.engage) class_engage = opts.engage;
    if (opts.tick) class_tick = opts.tick;
    if (ROLE == "merchant") attack_mode = false;

    farmingStarted = true;
    try { if (typeof performance_trick == "function") performance_trick(); } catch (e) {}
    game_log("Started " + ROLE + " (" + (character.ctype || "?")
             + (ROLE == "farmer" ? ", " + FARM_STYLE : "") + ")", "#00FF00");

    setInterval(function () {
        try {
            tick();
        } catch (e) {
            game_log("SCRIPT ERROR: " + (e && e.message ? e.message : e), "#FF3333");
        }
    }, 1000 / 4);
}

} // end COMMON_LOADED guard
