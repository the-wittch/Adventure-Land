// Adventure Land - Ranger farmer (kite + supershot / 3shot)
load_code("common");

function ranger_skills(target) {
    try_skill("huntersmark", target, 0.15);
    try_skill("supershot", target, 0.25);
    // 3shot hits a primary + nearby; safe even with one target.
    try_skill("3shot", target, 0.3);
}

begin_farming({
    role: "farmer",
    style: "kite",
    skills: ranger_skills
});
