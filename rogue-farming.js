// Adventure Land - Rogue farmer (melee stick + opener skills)
load_code("common");

function rogue_skills(target) {
    // Open from stealth when available, then burn cheap damage skills.
    try_skill("invis", null, 0.1);
    try_skill("quickpunch", target, 0.2);
    try_skill("quickstab", target, 0.2);
    try_skill("sting", target, 0.25);
}

begin_farming({
    role: "farmer",
    style: "melee",
    skills: rogue_skills
});
