// Adventure Land - Dynamic kite-farming mage (with chat-log diagnostics)
var attack_mode = true;

// ---- Tunables ----
var MAX_MONSTER_HP = 5000;   // skip higher-hp (boss) monsters
var ENGAGE_RANGE   = 700;    // only target monsters within this distance
var BUY_AT_HPOT    = 5;
var BUY_AT_MPOT    = 5;
var BUY_TO          = 50;
var GOO_GOLD_GOAL  = 100;    // once we have this much gold, try town again

var returnPos = null;
var lowGold  = false;        // broke -> farm goo until we can afford pots
var lastState = "";

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
    return e && e.type == "monster" && !e.dead && e.hp > 0;
}

function is_junk(m) {
    if (m.mtype == "dummy") return true;          // training dummies
    if (m.max_hp > MAX_MONSTER_HP) return true;   // bosses / tanky mobs
    return false;
}

function best_score_target() {
    var best = null, bestScore = 0;
    var nearest = null, nearestD = Infinity;
    for (var id in parent.entities) {
        var m = parent.entities[id];
        if (!is_monster(m) || is_junk(m)) continue;
        var d = distance(character, m);
        if (d > ENGAGE_RANGE) continue;
        if (d < nearestD) { nearestD = d; nearest = m; }

        var xp  = Number(m.xp) || 0;
        var atk = Number(m.attack) || 0;
        var def = Number(m.defense) || 0;
        var hp  = Number(m.hp) || 1;
        var score = xp / (atk + def + hp / 100) / (1 + d / 300);
        if (score > bestScore) { bestScore = score; best = m; }
    }
    return best || nearest; // fall back to closest non-junk monster
}

function pick_target() {
    if (lowGold) {
        var best = null, bestD = Infinity;
        for (var id in parent.entities) {
            var m = parent.entities[id];
            if (!is_monster(m) || m.mtype != "goo") continue;
            var d = distance(character, m);
            if (d < bestD) { bestD = d; best = m; }
        }
        return best;
    }
    return best_score_target();
}

// ---- Return to the saved farming spot ----
function go_back() {
    if (!returnPos) return;
    var p = returnPos;
    returnPos = null;
    if (p.map == character.map) {
        smart_move({ x: p.x, y: p.y });
    } else {
        smart_move({ to: p.map }, function () {
            smart_move({ x: p.x, y: p.y });
        });
    }
}

// ---- Mage burst, if the skill is available ----
function mage_burst(target) {
    try {
        if (can_use("burst")
            && character.mp > (G.skills.burst.mp + character.max_mp * 0.3)
            && is_in_range(target, "burst")
            && !is_on_cooldown("burst")) {
            use_skill("burst");
        }
    } catch (e) { /* skill not unlocked yet */ }
}

function engage(target) {
    var dist = distance(character, target);
    var tooClose = Math.min(target.range + 25, character.range * 0.5);

    if (dist < tooClose) {
        note("Kiting " + target.mtype + " d=" + Math.round(dist), "#FFAA00");
        var dx = character.real_x - target.x;
        var dy = character.real_y - target.y;
        var len = Math.sqrt(dx * dx + dy * dy);
        if (len < 1) { // stacked on the mob: pick any direction
            dx = Math.random() - 0.5;
            dy = Math.random() - 0.5;
            len = 1;
        }
        var step = Math.max(character.range * 0.5, 40);
        move(
            character.real_x + (dx / len) * step,
            character.real_y + (dy / len) * step
        );
        return;
    }

    if (is_in_range(target)) {
        if (can_attack(target)) {
            note("Attacking " + target.mtype + " d=" + Math.round(dist), "#00FF00");
            attack(target);
        }
        mage_burst(target);
        return;
    }

    note("Approaching " + target.mtype + " d=" + Math.round(dist), "#00AAFF");
    if (dist > 400) {
        if (typeof smart == "undefined" || !smart.moving) smart_move({ x: target.x, y: target.y });
    } else {
        move(
            character.real_x + (target.x - character.real_x) * 0.4,
            character.real_y + (target.y - character.real_y) * 0.4
        );
    }
}

function tick() {
    use_hp_or_mp();
    loot();

    if (character.rip) { note("Dead, respawning...", "#FF0000"); return; }
    if (is_moving(character) || (typeof smart != "undefined" && smart.moving)) return;

    // ---- Restock (or goo farm when broke) ----
    if (hpot_count() <= BUY_AT_HPOT || mpot_count() <= BUY_AT_MPOT) {

        if (lowGold && character.gold >= GOO_GOLD_GOAL) {
            lowGold = false;
            note("Enough gold, going shopping", "#00FF00");
        }

        if (!lowGold) {
            if (is_in_town()) {
                buy_with_gold("hpot0", BUY_TO - hpot_count());
                buy_with_gold("mpot0", BUY_TO - mpot_count());
                game_log("Restocked: hpot=" + hpot_count() + " mpot=" + mpot_count()
                         + " gold=" + character.gold, "#00FF00");
                if (hpot_count() < BUY_AT_HPOT && mpot_count() < BUY_AT_MPOT) {
                    lowGold = true;
                    note("Broke! Farming goo for gold", "#FF8800");
                }
                go_back();
            } else if (!returnPos) {
                returnPos = { map: character.map, x: character.x, y: character.y };
                note("Pots low, heading to town", "#FF8800");
                smart_move({ to: "main" });
            }
            return;
        }
        // lowGold: fall through and fight goo below
    }

    if (!attack_mode) { note("attack_mode is OFF", "#FF5555"); return; }

    var target = get_targeted_monster();
    if (!target || target.dead || target.hp <= 0 || is_junk(target)
        || distance(character, target) > ENGAGE_RANGE) {
        target = pick_target();
        if (target) change_target(target);
    }

    if (!target) {
        var info = [];
        for (var id in parent.entities) {
            var m = parent.entities[id];
            if (m.type != "monster") continue;
            info.push(m.mtype + " mhp=" + (m.max_hp) + " hp=" + (m.hp)
                      + " xp=" + (m.xp) + " atk=" + (m.attack)
                      + " d=" + Math.round(distance(character, m)));
            if (info.length >= 5) break;
        }
        note("No targets. " + (info.join(" | ") || "none"), "#FF5555");
        return;
    }

    var d = distance(character, target);
    note("Target " + target.mtype + " hp=" + Math.round(target.hp)
         + " xp=" + target.xp + " d=" + Math.round(d), "#00FFFF");

    engage(target);
}

setInterval(function () {
    try {
        tick();
    } catch (e) {
        game_log("SCRIPT ERROR: " + (e && e.message ? e.message : e), "#FF3333");
    }
}, 1000 / 4);
