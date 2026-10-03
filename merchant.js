// Adventure Land - Merchant town/economy helper (not a combat farmer)
// Hangs near town, restocks potions, compounds/equips/banks via common tidy.
load_code("common");

function merchant_tick() {
    if (steer_tick()) return;
    if (is_moving(character) || (typeof smart != "undefined" && smart.moving)) return;

    if (shopping && shoppingStart && Date.now() - shoppingStart > 5 * 60 * 1000) {
        game_log("Town trip timed out", "#FF8800");
        shopping = false;
        tidyFinished = true;
        return;
    }
    if (shopping) return;

    // Restock / tidy when pots are low or the bag is nearly full.
    if (maybe_restock()) return;

    // Stay near town so party members can find you / you can process loot.
    if (character.map == "bank") {
        leave_bank();
        return;
    }

    var inTown = character.map == "main" || character.map == "mainland"
        || character.map == "winterland" || character.map == "halloween";
    if (!inTown) {
        note("Merchant returning to town", "#FF8800");
        smart_move({ to: "town" }).catch(function (e) {
            game_log("Town path failed: " + (e && e.reason ? e.reason : e), "#FF3333");
        });
        return;
    }

    if (lowGold) status("Merchant waiting for gold");
    else status("Merchant idle in town");
}

begin_farming({
    role: "merchant",
    tick: merchant_tick
});
