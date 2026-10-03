// Adventure Land - Priest farmer (kite + curse / self-heal / partyheal)
load_code("common");

function priest_skills(target) {
    // Keep yourself alive first, then support the party, then debuff.
    if (character.hp < character.max_hp * 0.7)
        try_skill("heal", character, 0.15);

    if (typeof parent != "undefined" && parent.party) {
        for (var name in parent.party) {
            var mate = parent.entities[name] || (name == character.name ? character : null);
            if (!mate || mate.rip) continue;
            if (mate.hp < mate.max_hp * 0.55) {
                if (try_skill("heal", mate, 0.15)) return;
            }
        }
        // Party-wide heal when anyone is hurting.
        for (var n in parent.party) {
            var m = parent.entities[n] || (n == character.name ? character : null);
            if (m && !m.rip && m.hp < m.max_hp * 0.45) {
                try_skill("partyheal", null, 0.35);
                break;
            }
        }
    }

    try_skill("curse", target, 0.2);
    try_skill("darkblessing", null, 0.25);
}

begin_farming({
    role: "farmer",
    style: "kite",
    skills: priest_skills
});
