// Adventure Land - Mage farmer (kite + burst)
// In-game: create code files named "common" and "mage-farming", paste each, then run this.
load_code("common");

function mage_skills(target) {
    // Burst when we have a healthy mana reserve left for potions/regen.
    try_skill("burst", target, 0.3);
}

begin_farming({
    role: "farmer",
    style: "kite",
    skills: mage_skills
});
