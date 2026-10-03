// Adventure Land - Warrior farmer (melee stick + taunt/charge)
load_code("common");

function warrior_skills(target) {
    // Pull / gap-close, then spend rage skills when cheap enough on mana.
    try_skill("taunt", target, 0.15);
    try_skill("charge", target, 0.15);
    try_skill("hardshell", null, 0.1);
    try_skill("warcry", null, 0.2);
    try_skill("cleave", target, 0.25);
}

begin_farming({
    role: "farmer",
    style: "melee",
    skills: warrior_skills
});
