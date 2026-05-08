import { describe, expect, test } from "bun:test";
import {
  addBusinessDays,
  computeSchedule,
  formatDate,
  parseDate,
  type ScheduleInput,
} from "../../src/planning/scheduler.ts";

function emptyInput(): ScheduleInput {
  return {
    startDate: "2026-01-05", // Monday
    wishes: [],
    teams: [],
    deadlines: [],
    tags: [],
  };
}

describe("planning scheduler", () => {
  test("addBusinessDays skips weekends", () => {
    // Friday + 1 = Monday (skip Sat+Sun).
    const fri = parseDate("2026-01-09");
    const mon = addBusinessDays(fri, 1);
    expect(formatDate(mon)).toBe("2026-01-12");
  });

  test("simple chain places sequentially when team_max=1", () => {
    const input: ScheduleInput = {
      ...emptyInput(),
      teams: [{ id: 1, maxParallel: 1 }],
      wishes: [
        {
          id: 10,
          durationDays: 2,
          teamId: 1,
          deadlineId: null,
          dependsOnWishes: [],
          dependsOnTags: [],
          tagIds: [],
        },
        {
          id: 11,
          durationDays: 3,
          teamId: 1,
          deadlineId: null,
          dependsOnWishes: [],
          dependsOnTags: [],
          tagIds: [],
        },
      ],
    };
    const out = computeSchedule(input);
    const p10 = out.placements.find((p) => p.wishId === 10)!;
    const p11 = out.placements.find((p) => p.wishId === 11)!;
    // First wish: Mon-Tue
    expect(p10.start).toBe("2026-01-05");
    expect(p10.end).toBe("2026-01-06");
    // Second wish must start strictly after first ends, and team_max=1.
    expect(p11.start > p10.end).toBe(true);
    // 3 working days starting Wed = Wed-Thu-Fri.
    expect(p11.start).toBe("2026-01-07");
    expect(p11.end).toBe("2026-01-09");
  });

  test("team_max>1 places wishes in parallel", () => {
    const input: ScheduleInput = {
      ...emptyInput(),
      teams: [{ id: 1, maxParallel: 3 }],
      wishes: [
        { id: 10, durationDays: 2, teamId: 1, deadlineId: null, dependsOnWishes: [], dependsOnTags: [], tagIds: [] },
        { id: 11, durationDays: 2, teamId: 1, deadlineId: null, dependsOnWishes: [], dependsOnTags: [], tagIds: [] },
        { id: 12, durationDays: 2, teamId: 1, deadlineId: null, dependsOnWishes: [], dependsOnTags: [], tagIds: [] },
      ],
    };
    const out = computeSchedule(input);
    const starts = out.placements.map((p) => p.start);
    // All three start the same day.
    expect(new Set(starts).size).toBe(1);
  });

  test("dependency forces sequential placement across teams", () => {
    const input: ScheduleInput = {
      ...emptyInput(),
      teams: [
        { id: 1, maxParallel: 1 },
        { id: 2, maxParallel: 1 },
      ],
      wishes: [
        {
          id: 10,
          durationDays: 2,
          teamId: 1,
          deadlineId: null,
          dependsOnWishes: [],
          dependsOnTags: [],
          tagIds: [],
        },
        {
          id: 11,
          durationDays: 1,
          teamId: 2,
          deadlineId: null,
          dependsOnWishes: [10],
          dependsOnTags: [],
          tagIds: [],
        },
      ],
    };
    const out = computeSchedule(input);
    const p10 = out.placements.find((p) => p.wishId === 10)!;
    const p11 = out.placements.find((p) => p.wishId === 11)!;
    expect(p10.end).toBe("2026-01-06"); // Tuesday
    expect(p11.start).toBe("2026-01-07"); // Wednesday (strictly after dep)
  });

  test("cycle detection emits cycle bottleneck", () => {
    const input: ScheduleInput = {
      ...emptyInput(),
      wishes: [
        { id: 10, durationDays: 1, teamId: null, deadlineId: null, dependsOnWishes: [11], dependsOnTags: [], tagIds: [] },
        { id: 11, durationDays: 1, teamId: null, deadlineId: null, dependsOnWishes: [10], dependsOnTags: [], tagIds: [] },
      ],
    };
    const out = computeSchedule(input);
    expect(out.bottlenecks.find((b) => b.kind === "cycle")).toBeDefined();
    expect(out.placements.length).toBe(0);
  });

  test("tag dependency waits for all tagged wishes", () => {
    const input: ScheduleInput = {
      ...emptyInput(),
      teams: [{ id: 1, maxParallel: 5 }],
      tags: [{ id: 100, name: "infra" }],
      wishes: [
        // Wish A — has tag "infra", duration 3 days
        { id: 10, durationDays: 3, teamId: 1, deadlineId: null, dependsOnWishes: [], dependsOnTags: [], tagIds: [100] },
        // Wish B — depends on tag "infra"
        { id: 11, durationDays: 1, teamId: 1, deadlineId: null, dependsOnWishes: [], dependsOnTags: ["infra"], tagIds: [] },
      ],
    };
    const out = computeSchedule(input);
    const p10 = out.placements.find((p) => p.wishId === 10)!;
    const p11 = out.placements.find((p) => p.wishId === 11)!;
    expect(p10.start).toBe("2026-01-05");
    expect(p10.end).toBe("2026-01-07"); // Mon-Wed (3 working days)
    // p11 should start strictly after p10.end.
    expect(p11.start > p10.end).toBe(true);
  });

  test("deadline overrun emits bottleneck", () => {
    const input: ScheduleInput = {
      ...emptyInput(),
      teams: [{ id: 1, maxParallel: 1 }],
      deadlines: [{ id: 200, dueDate: "2026-01-06" }],
      wishes: [
        {
          id: 10,
          durationDays: 5, // Mon-Fri
          teamId: 1,
          deadlineId: 200,
          dependsOnWishes: [],
          dependsOnTags: [],
          tagIds: [],
        },
      ],
    };
    const out = computeSchedule(input);
    const bottleneck = out.bottlenecks.find((b) => b.kind === "deadline_overrun");
    expect(bottleneck).toBeDefined();
    expect(bottleneck?.wishId).toBe(10);
  });

  test("weekend skip in long durations", () => {
    // 1 wish of 6 working days starting Monday → ends following Mon.
    const input: ScheduleInput = {
      ...emptyInput(),
      wishes: [
        { id: 10, durationDays: 6, teamId: null, deadlineId: null, dependsOnWishes: [], dependsOnTags: [], tagIds: [] },
      ],
    };
    const out = computeSchedule(input);
    const p = out.placements.find((x) => x.wishId === 10)!;
    expect(p.start).toBe("2026-01-05");
    // Mon, Tue, Wed, Thu, Fri (5 days), skip Sat+Sun, Mon = day 6.
    expect(p.end).toBe("2026-01-12");
  });

  test("missing team produces missing_team bottleneck", () => {
    const input: ScheduleInput = {
      ...emptyInput(),
      wishes: [
        { id: 10, durationDays: 1, teamId: 999, deadlineId: null, dependsOnWishes: [], dependsOnTags: [], tagIds: [] },
      ],
    };
    const out = computeSchedule(input);
    expect(
      out.bottlenecks.find((b) => b.kind === "missing_team" && b.wishId === 10),
    ).toBeDefined();
    // Wish still placed (using unbounded synthetic team).
    expect(out.placements.find((p) => p.wishId === 10)).toBeDefined();
  });

  test("project start in the future shifts all placements", () => {
    const input: ScheduleInput = {
      ...emptyInput(),
      startDate: "2026-06-01", // Monday
      wishes: [
        { id: 10, durationDays: 2, teamId: null, deadlineId: null, dependsOnWishes: [], dependsOnTags: [], tagIds: [] },
      ],
    };
    const out = computeSchedule(input);
    expect(out.placements[0]!.start).toBe("2026-06-01");
  });

  describe("placement reasons", () => {
    test("single wish with no deps gets project_start reason", () => {
      const input: ScheduleInput = {
        ...emptyInput(),
        wishes: [
          { id: 10, durationDays: 1, teamId: null, deadlineId: null, dependsOnWishes: [], dependsOnTags: [], tagIds: [] },
        ],
      };
      const out = computeSchedule(input);
      const p = out.placements.find((x) => x.wishId === 10)!;
      expect(p.reason.kind).toBe("project_start");
      expect(p.reason.blockingWishIds).toEqual([]);
      expect(p.reason.blockingTagNames).toEqual([]);
    });

    test("wish blocked by explicit wish dep gets dependency reason", () => {
      const input: ScheduleInput = {
        ...emptyInput(),
        wishes: [
          { id: 10, durationDays: 2, teamId: null, deadlineId: null, dependsOnWishes: [], dependsOnTags: [], tagIds: [] },
          { id: 11, durationDays: 1, teamId: null, deadlineId: null, dependsOnWishes: [10], dependsOnTags: [], tagIds: [] },
        ],
      };
      const out = computeSchedule(input);
      const p11 = out.placements.find((x) => x.wishId === 11)!;
      expect(p11.reason.kind).toBe("dependency");
      expect(p11.reason.blockingWishIds).toContain(10);
      expect(p11.reason.blockingTagNames).toEqual([]);
    });

    test("wish blocked only by team capacity gets team_capacity reason", () => {
      // Two wishes on the same team with maxParallel=1; second must wait.
      const input: ScheduleInput = {
        ...emptyInput(),
        teams: [{ id: 1, maxParallel: 1 }],
        wishes: [
          { id: 10, durationDays: 2, teamId: 1, deadlineId: null, dependsOnWishes: [], dependsOnTags: [], tagIds: [] },
          { id: 11, durationDays: 1, teamId: 1, deadlineId: null, dependsOnWishes: [], dependsOnTags: [], tagIds: [] },
        ],
      };
      const out = computeSchedule(input);
      const p11 = out.placements.find((x) => x.wishId === 11)!;
      expect(p11.reason.kind).toBe("team_capacity");
      expect(p11.reason.blockingWishIds).toEqual([]);
    });

    test("wish blocked by both dep and team capacity gets dependency_and_team reason", () => {
      // Team maxParallel=1: wish 10 (5 days) occupies team Mon-Fri.
      // Wish 11 depends on wish 10 and is on the same team — team also
      // has another 5-day wish (12) starting right after 10, so wish 11
      // gets pushed again by team capacity.
      const input: ScheduleInput = {
        ...emptyInput(),
        teams: [{ id: 1, maxParallel: 1 }],
        wishes: [
          { id: 10, durationDays: 5, teamId: 1, deadlineId: null, dependsOnWishes: [], dependsOnTags: [], tagIds: [] },
          // Wish 12 fills the slot right after wish 10 so wish 11 is pushed further.
          { id: 12, durationDays: 5, teamId: 1, deadlineId: null, dependsOnWishes: [], dependsOnTags: [], tagIds: [] },
          { id: 11, durationDays: 1, teamId: 1, deadlineId: null, dependsOnWishes: [10], dependsOnTags: [], tagIds: [] },
        ],
      };
      const out = computeSchedule(input);
      const p11 = out.placements.find((x) => x.wishId === 11)!;
      expect(p11.reason.kind).toBe("dependency_and_team");
      expect(p11.reason.blockingWishIds).toContain(10);
    });

    test("wish blocked by tag dep gets dependency reason with tag name", () => {
      const input: ScheduleInput = {
        ...emptyInput(),
        tags: [{ id: 100, name: "infra" }],
        wishes: [
          { id: 10, durationDays: 2, teamId: null, deadlineId: null, dependsOnWishes: [], dependsOnTags: [], tagIds: [100] },
          { id: 11, durationDays: 1, teamId: null, deadlineId: null, dependsOnWishes: [], dependsOnTags: ["infra"], tagIds: [] },
        ],
      };
      const out = computeSchedule(input);
      const p11 = out.placements.find((x) => x.wishId === 11)!;
      expect(p11.reason.kind).toBe("dependency");
      expect(p11.reason.blockingTagNames).toContain("infra");
    });
  });

  describe("nonWorkingDates calendar integration", () => {
    test("addBusinessDays skips holidays in nonWorkingDates", () => {
      // 2026-01-12 is a Monday; mark it as non-working.
      const nwd = new Set(["2026-01-12"]);
      const fri = parseDate("2026-01-09");
      // Without nwd: Fri+1 = Mon Jan 12.
      expect(formatDate(addBusinessDays(fri, 1))).toBe("2026-01-12");
      // With nwd: Mon Jan 12 is skipped → Tue Jan 13.
      expect(formatDate(addBusinessDays(fri, 1, nwd))).toBe("2026-01-13");
    });

    test("10-day wish skips a mid-week holiday", () => {
      // Start on Mon 2026-01-05; mark Wed 2026-01-07 as non-working (holiday).
      const nwd = new Set(["2026-01-07"]);
      const input: ScheduleInput = {
        ...emptyInput(),
        startDate: "2026-01-05",
        nonWorkingDates: nwd,
        wishes: [
          { id: 10, durationDays: 3, teamId: null, deadlineId: null, dependsOnWishes: [], dependsOnTags: [], tagIds: [] },
        ],
      };
      const out = computeSchedule(input);
      const p = out.placements[0]!;
      // 3 working days: Mon 5, Tue 6, (Wed 7 skipped), Thu 8 = end
      expect(p.start).toBe("2026-01-05");
      expect(p.end).toBe("2026-01-08");
    });

    test("wish starts day after holiday when project starts on holiday", () => {
      const nwd = new Set(["2026-01-05"]); // Monday Jan 5 is a holiday
      const input: ScheduleInput = {
        ...emptyInput(),
        startDate: "2026-01-05",
        nonWorkingDates: nwd,
        wishes: [
          { id: 10, durationDays: 1, teamId: null, deadlineId: null, dependsOnWishes: [], dependsOnTags: [], tagIds: [] },
        ],
      };
      const out = computeSchedule(input);
      // Should start on Tue Jan 6, not on the holiday.
      expect(out.placements[0]!.start).toBe("2026-01-06");
    });

    test("dependency end + 1 skips holidays correctly", () => {
      const nwd = new Set(["2026-01-07"]); // Wed Jan 7 holiday
      const input: ScheduleInput = {
        ...emptyInput(),
        startDate: "2026-01-05",
        nonWorkingDates: nwd,
        wishes: [
          { id: 1, durationDays: 2, teamId: null, deadlineId: null, dependsOnWishes: [], dependsOnTags: [], tagIds: [] },
          { id: 2, durationDays: 1, teamId: null, deadlineId: null, dependsOnWishes: [1], dependsOnTags: [], tagIds: [] },
        ],
      };
      const out = computeSchedule(input);
      const w1 = out.placements.find((p) => p.wishId === 1)!;
      const w2 = out.placements.find((p) => p.wishId === 2)!;
      // Wish 1: Mon 5, Tue 6 (end). Next working day after Tue 6 = Thu 8 (Wed 7 skipped).
      expect(w1.end).toBe("2026-01-06");
      expect(w2.start).toBe("2026-01-08");
    });
  });
});
