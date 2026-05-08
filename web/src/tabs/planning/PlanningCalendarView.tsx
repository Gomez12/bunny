import { useCallback, useEffect, useState } from "react";
import type {
  CalendarException,
  PlanningProject,
  PlanningTeam,
} from "../../api";
import {
  createPlanningCalendarException,
  createTeamCalendarException,
  deleteCalendarException,
  listPlanningCalendarExceptions,
  listPlanningTeams,
  listTeamCalendarExceptions,
  patchCalendarException,
} from "../../api";
import { ChevronDown, ChevronRight, ICON_DEFAULTS, Users } from "../../lib/icons";
import CalendarExceptionEditor from "../../components/CalendarExceptionEditor";

interface Props {
  planningProject: PlanningProject;
}

export default function PlanningCalendarView({ planningProject }: Props) {
  const [ppExceptions, setPpExceptions] = useState<CalendarException[]>([]);
  const [teams, setTeams] = useState<PlanningTeam[]>([]);
  const [teamExceptions, setTeamExceptions] = useState<Map<number, CalendarException[]>>(new Map());
  const [expandedTeams, setExpandedTeams] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const reloadPp = useCallback(async () => {
    try {
      setPpExceptions(await listPlanningCalendarExceptions(planningProject.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [planningProject.id]);

  const reloadTeamExceptions = useCallback(async (teamId: number) => {
    try {
      const excs = await listTeamCalendarExceptions(teamId);
      setTeamExceptions((prev) => new Map(prev).set(teamId, excs));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void reloadPp();
    void listPlanningTeams(planningProject.id).then(setTeams).catch((e) =>
      setError(e instanceof Error ? e.message : String(e)),
    );
  }, [planningProject.id, reloadPp]);

  const toggleTeam = async (teamId: number) => {
    const next = new Set(expandedTeams);
    if (next.has(teamId)) {
      next.delete(teamId);
    } else {
      next.add(teamId);
      if (!teamExceptions.has(teamId)) {
        await reloadTeamExceptions(teamId);
      }
    }
    setExpandedTeams(next);
  };

  return (
    <div className="planning-view">
      <header className="planning-view__header">
        <h2>Calendar</h2>
      </header>
      {error && <div className="planning-tab__error">{error}</div>}

      <section className="cal-section">
        <h3 className="cal-section__title">Planning project — {planningProject.name}</h3>
        <p className="muted" style={{ fontSize: 13, marginBottom: 12 }}>
          Days marked here apply to this entire planning project.
        </p>
        <CalendarExceptionEditor
          exceptions={ppExceptions}
          canEdit
          scope="planning"
          scopeId={planningProject.id}
          onAdd={async (date, kind, name) => {
            await createPlanningCalendarException(planningProject.id, { date, kind, name });
            await reloadPp();
          }}
          onUpdate={async (id, patch) => {
            await patchCalendarException("planning", id, patch, planningProject.id);
            await reloadPp();
          }}
          onDelete={async (id) => {
            await deleteCalendarException("planning", id, planningProject.id);
            await reloadPp();
          }}
        />
      </section>

      {teams.length > 0 && (
        <section className="cal-section" style={{ marginTop: 24 }}>
          <h3 className="cal-section__title">Team calendars</h3>
          <p className="muted" style={{ fontSize: 13, marginBottom: 12 }}>
            Team-specific days override the planning-project calendar for members of that team.
          </p>
          <ul className="planning-card-list">
            {teams.map((team) => {
              const expanded = expandedTeams.has(team.id);
              const excs = teamExceptions.get(team.id) ?? [];
              return (
                <li key={team.id}>
                  <article className="planning-card">
                    <div className="planning-card__head">
                      <span
                        className="planning-card__swatch"
                        style={{ background: team.color ?? "var(--text-faint)" }}
                        aria-hidden="true"
                      />
                      <span className="planning-card__name">{team.name}</span>
                      <span className="planning-card__meta">
                        <Users size={12} /> {team.members.length}
                      </span>
                      <button
                        type="button"
                        className="planning-card__action-btn"
                        onClick={() => void toggleTeam(team.id)}
                        title={expanded ? "Collapse" : "Expand calendar"}
                      >
                        {expanded
                          ? <ChevronDown {...ICON_DEFAULTS} />
                          : <ChevronRight {...ICON_DEFAULTS} />}
                      </button>
                    </div>
                    {expanded && (
                      <div style={{ paddingTop: 12 }}>
                        <CalendarExceptionEditor
                          exceptions={excs}
                          canEdit
                          scope="team"
                          scopeId={team.id}
                          onAdd={async (date, kind, name) => {
                            await createTeamCalendarException(team.id, { date, kind, name });
                            await reloadTeamExceptions(team.id);
                          }}
                          onUpdate={async (id, patch) => {
                            await patchCalendarException("team", id, patch, team.id);
                            await reloadTeamExceptions(team.id);
                          }}
                          onDelete={async (id) => {
                            await deleteCalendarException("team", id, team.id);
                            await reloadTeamExceptions(team.id);
                          }}
                        />
                      </div>
                    )}
                  </article>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}
