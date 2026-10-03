// Adventure Land - Paladin farmer (melee stick + self-support skills)
load_code("common");

function paladin_skills(target) {
    if (character.hp < character.max_hp * 0.55)
        try_skill("selfheal", null, 0.15);
    try_skill("smash", target, 0.2);
    try_skill("purge", target, 0.2);
    try_skill("mshield", null, 0.15);
}

begin_farming({
    role: "farmer",
    style: "melee",
    skills: paladin_skills
});
