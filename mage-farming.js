// Adventure Land - Dynamic kite-farming mage (with chat-log diagnostics)
var attack_mode = true;

// ---- Tunables ----
var MAX_MONSTER_HP = 5000;   // skip higher-hp (boss) monsters
var ENGAGE_RANGE   = 700;    // only target monsters within this distance
var BUY_AT_HPOT    = 5;
var BUY_AT_MPOT    = 5;
var BUY_TO          = 50;
var GOO_GOLD_GOAL  = 100;    // once we have this much gold, try town again
var ROAM_MAX_ATT   = 150;    // when roaming, ignore species with attack above this
var ROAM_DELAY     = 8;      // seconds with no target before relocating
var ROAM_COOLDOWN  = 30;     // seconds between failed roam attempts (prevents spam)
var ACTION_INTERVAL = 110;   // ms between dispatched game actions (~9/s, under server cap)

var returnPos = null;
var lowGold  = false;        // broke -> farm goo until we can afford pots
var shopping = false;        // currently on a potion-buying trip
var lastTarget = Date.now();
var lastRoam  = 0;           // timestamp of last roam attempt (cooldown)
var failedMaps = {};         // maps smart_move rejected; retried once stale (10 min)
var lastState = "";
var lastAction = 0;          // timestamp of the last game action dispatched
var lastAttack = 0;          // timestamp of the last attack dispatched
var attackBackoff = 0;       // extra ms between attacks; grows on server rejections
var cooldownRejects = 0;     // counters rejected cooldown attacks (logged every N)

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
        var d = parent.distance(character, m);
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
    var best = null, bestScore = 0;
    for (var type in avail) {
        if (type == "dummy") continue;
        var md = G.monsters[type];
        if (!md) continue;
        var hp  = Number(md.hp) || 0;
        var atk = Number(md.attack) || 0;
        var xp  = Number(md.xp) || 0;
        if (hp <= 0 || hp > MAX_MONSTER_HP) continue; // bosses
        if (atk > ROAM_MAX_ATT) continue;             // too dangerous
        var score = xp / (atk + hp / 100);
        if (spawn_on_map(type, character.map)) score *= 1.3; // prefer staying
        if (score > bestScore) { bestScore = score; best = type; }
    }
    return best;
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

function roam() {
    if (shopping || smart.moving) return;
    if (Date.now() - lastRoam < ROAM_COOLDOWN * 1000) return; // silent, kills reject-spam
    lastRoam = Date.now();
    var type = lowGold ? "goo" : best_roam_species();
    if (!type) { note("No roam target found", "#FF5555"); return; }
    var spot = find_spawn(type);
    if (!spot) { note("No spawn for " + type, "#FF5555"); return; }
    if (!G.maps[spot.map]) { note("Skipping unknown map " + spot.map, "#FF5555"); return; }
    delete failedMaps[spot.map];
    note("Roaming to " + type + " on " + spot.map
         + " [" + Math.round(spot.x) + "," + Math.round(spot.y) + "]", "#AA66FF");
    var settle = function () { returnPos = { map: spot.map, x: spot.x, y: spot.y }; };
    var walk = spot.map == character.map
        ? smart_move({ map: character.map, x: spot.x, y: spot.y })
        : smart_move({ to: spot.map }).then(function () {
              return smart_move({ map: character.map, x: spot.x, y: spot.y });
          });
    walk.then(settle).catch(function (e) {
        mark_failed_map(spot.map);
        game_log("Roam failed: " + (e && e.reason ? e.reason : e), "#FF3333");
    });
}

// ---- Return to the saved farming spot ----
function go_back() {
    if (!returnPos) return;
    var p = returnPos;
    returnPos = null;
    if (p.map == character.map) {
        smart_move({ x: p.x, y: p.y }).catch(function (e) {
            game_log("Return failed: " + (e && e.reason ? e.reason : e), "#FF3333");
        });
    } else {
        smart_move({ to: p.map }).then(function () {
            return smart_move({ x: p.x, y: p.y });
        }).catch(function (e) {
            game_log("Return failed: " + (e && e.reason ? e.reason : e), "#FF3333");
        });
    }
}

// ---- Walk to the potion vendor, buy with available gold, then return ----
function go_shopping() {
    if (shopping) return;
    shopping = true;
    if (!returnPos && character.map) {
        returnPos = { map: character.map, x: character.x, y: character.y };
    }
    note("Pots low, going to town", "#FF8800");
    smart_move({ to: "potions" }).then(function () {
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
        shopping = false;
        go_back();
    }).catch(function (e) {
        game_log("Shop trip failed: " + (e && e.reason ? e.reason : e), "#FF3333");
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
        if (can_attack(target)
            && Date.now() - lastAttack >= attackBackoff
            && action_ready()) {
            lastAttack = Date.now();
            note("Attacking " + target.mtype + " d=" + Math.round(dist), "#00FF00");
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
        }
        mage_burst(target);
        return;
    }

    note("Approaching " + target.mtype + " d=" + Math.round(dist), "#00AAFF");
    var px = character.real_x + (target.x - character.real_x) * 0.4;
    var py = character.real_y + (target.y - character.real_y) * 0.4;
    if (dist > 400 && character.map && (typeof smart == "undefined" || !smart.moving)) {
        smart_move({ map: character.map, x: target.x, y: target.y }).catch(function () {});
    } else {
        xmove(px, py).catch(function () {});
    }
}

function tick() {
    use_hp_or_mp();
    loot();

    if (character.rip) { note("Dead, respawning...", "#FF0000"); return; }
    if (is_moving(character) || (typeof smart != "undefined" && smart.moving)) return;
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
