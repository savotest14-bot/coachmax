# Frontend Integration Guide: League Fixtures & Random Generation

This guide explains how frontend applications (React, Next.js, Vue, Angular, or Mobile React Native) integrate with the CoachMax **League & Fixture Management API**.

---

## 1. Core Concepts & Workflow

```text
  ┌────────────────┐
  │ Create League  │
  │ (Select Teams) │
  └───────┬────────┘
          ▼
  ┌─────────────────────────────────┐
  │ Generate Random Fixtures        │ ◄────────────────────────┐
  │ POST .../generate-random-fixtures│                          │
  └───────┬─────────────────────────┘                          │
          ▼                                                    │
  ┌─────────────────────────────────┐                          │
  │ In-Place Update (No Duplicates) │                          │
  │ Existing fixtures updated       │                          │
  └───────┬─────────────────────────┘                          │
          ▼                                                    │
  ┌─────────────────────────────────┐                          │
  │ Review Schedule by Rounds       │                          │
  │ - Round 1, Round 2...           │                          │
  │ - Field & Time Slots            │                          │
  │ - BYE indicator for odd teams   │                          │
  └───────┬─────────────────────────┘                          │
          │                                                    │
          ├───► Admin wants new pairings: [Regenerate Again] ──┘
          │     (Reconciles in place, preserves IDs)
          │
          └───► Admin clicks [Edit Match]:
                PUT .../fixtures/:fixtureId
                - Marked as fixtureSource: "MANUAL"
                - Automatically PROTECTED from future random overwrites!
```

---

## 2. API Endpoints Reference

All endpoints require standard Admin authentication (`Authorization: Bearer <ADMIN_TOKEN>`).

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `POST` | `/api/admin/leagues/:leagueId/generate-random-fixtures` | Generate or Regenerate random round-robin fixtures in-place |
| `GET` | `/api/admin/leagues/:leagueId` | Fetch full league details, schedule by round, standings, and KPIs |
| `POST` | `/api/admin/leagues/:leagueId/fixtures` | Create a manual fixture |
| `PUT` | `/api/admin/leagues/:leagueId/fixtures/:fixtureId` | Manually edit an existing fixture (marks it `MANUAL`) |
| `DELETE` | `/api/admin/leagues/:leagueId/fixtures/:fixtureId` | Delete a manual or unplayed fixture |

---

## 3. TypeScript Interfaces

```typescript
// Fixture Status and Source
export type FixtureStatus = "SCHEDULED" | "LIVE" | "COMPLETED" | "POSTPONED" | "CANCELLED";
export type FixtureSource = "GENERATED" | "MANUAL";

export interface TeamSummary {
  _id: string;
  teamName: string;
  logo?: string;
}

export interface Fixture {
  _id: string;
  league: string;
  round: number;
  homeTeam: TeamSummary;
  awayTeam: TeamSummary;
  kickoffTime: string; // ISO Date string
  endTime?: string;    // ISO Date string
  venue: string;
  field?: string;      // e.g. "Field 1", "Field 2"
  group?: string;      // e.g. "Group A"
  status: FixtureStatus;
  score?: {
    homeScore: number;
    awayScore: number;
  };
  fixtureSource: FixtureSource;
  isManuallyModified: boolean;
}

export interface RoundSchedule {
  round: number;
  roundName: string;
  matches: Fixture[];
}

export interface LeagueConfig {
  _id: string;
  name: string;
  season: string;
  startDate: string;
  endDate: string;
  fixtureFormat: "ROUND_ROBIN" | "KNOCKOUT";
  numberOfRounds: number;        // 1 = Single Round Robin, 2 = Double Round Robin
  matchDuration: number;         // Minutes (e.g. 90)
  breakBetweenMatches: number;   // Minutes (e.g. 15)
  numberOfFields: number;        // e.g. 2
  startTime: string;             // e.g. "10:00"
  fixtureGenerated: boolean;
  groupCount: number;
  teams: TeamSummary[];
}

export interface GenerateFixturesResponse {
  success: boolean;
  message: string;
  data: {
    leagueId: string;
    teams: number;
    rounds: number;
    fixtures: number;
    created: number;             // Count of newly inserted records (first generation)
    updated: number;             // Count of in-place updated records (subsequent generations)
    deleted: number;
    manualFixturesPreserved: number; // Count of manual fixtures left untouched
    byes: number;                // Virtual BYEs (odd teams)
    daysUsed: number;
  };
}
```

---

## 4. API Service Functions (Axios / Fetch)

```javascript
// services/leagueFixturesApi.js
import axios from "axios";

const API_BASE_URL = process.env.REACT_APP_API_URL || "http://localhost:5000/api/admin";

const getAuthHeaders = () => ({
  headers: {
    Authorization: `Bearer ${localStorage.getItem("adminToken")}`,
    "Content-Type": "application/json",
  },
});

/**
 * 1. Generate or Regenerate Random Fixtures
 * @param {string} leagueId
 * @param {boolean} forceRegenerate Set to true to overwrite manual fixtures
 */
export const generateRandomFixtures = async (leagueId, forceRegenerate = false) => {
  const response = await axios.post(
    `${API_BASE_URL}/leagues/${leagueId}/generate-random-fixtures`,
    {
      randomize: true,
      forceRegenerate,
    },
    getAuthHeaders()
  );
  return response.data;
};

/**
 * 2. Fetch League Schedule & Fixtures
 * @param {string} leagueId
 * @param {number|null} round Optional round filter
 */
export const getLeagueData = async (leagueId, round = null) => {
  const params = round ? { round } : {};
  const response = await axios.get(
    `${API_BASE_URL}/leagues/${leagueId}`,
    {
      ...getAuthHeaders(),
      params,
    }
  );
  return response.data; // contains data.league, data.schedule, data.ladder, etc.
};

/**
 * 3. Update Fixture Manually (Teams, Date, Time, Field)
 * Automatically marks the fixture as MANUAL & isManuallyModified: true
 */
export const updateFixtureManually = async (leagueId, fixtureId, payload) => {
  const response = await axios.put(
    `${API_BASE_URL}/leagues/${leagueId}/fixtures/${fixtureId}`,
    payload,
    getAuthHeaders()
  );
  return response.data;
};

/**
 * 4. Create a Manual Fixture
 */
export const createManualFixture = async (leagueId, payload) => {
  const response = await axios.post(
    `${API_BASE_URL}/leagues/${leagueId}/fixtures`,
    payload,
    getAuthHeaders()
  );
  return response.data;
};

/**
 * 5. Delete a Fixture
 */
export const deleteFixture = async (leagueId, fixtureId) => {
  const response = await axios.delete(
    `${API_BASE_URL}/leagues/${leagueId}/fixtures/${fixtureId}`,
    getAuthHeaders()
  );
  return response.data;
};
```

---

## 5. Ready-to-Use React Component

Below is a complete, production-ready React component handling:
- **"Generate Random Fixtures"** and **"Regenerate Random"** buttons.
- Displaying Generation KPIs (`created`, `updated`, `manualFixturesPreserved`).
- Round selector tabs (`Round 1`, `Round 2`, `Round 3` ...).
- Match cards with Field badge, Kickoff & End time, and `MANUAL` / `GENERATED` tags.
- Virtual BYE notification for odd teams.
- Manual Edit Modal.
- Protection warning when completed/result matches are present.

```jsx
// components/LeagueFixturesManager.jsx
import React, { useState, useEffect } from "react";
import {
  generateRandomFixtures,
  getLeagueData,
  updateFixtureManually,
} from "../services/leagueFixturesApi";

export default function LeagueFixturesManager({ leagueId }) {
  const [loading, setLoading] = useState(false);
  const [league, setLeague] = useState(null);
  const [schedule, setSchedule] = useState([]);
  const [teams, setTeams] = useState([]);
  const [selectedRound, setSelectedRound] = useState(1);
  const [generationSummary, setGenerationSummary] = useState(null);
  const [errorMessage, setErrorMessage] = useState("");
  
  // Edit Modal State
  const [editingFixture, setEditingFixture] = useState(null);
  const [editFormData, setEditFormData] = useState({
    homeTeam: "",
    awayTeam: "",
    round: 1,
    kickoffTime: "",
    field: "Field 1",
    venue: "Main Stadium",
  });

  // Load league data
  const loadData = async () => {
    try {
      setLoading(true);
      setErrorMessage("");
      const res = await getLeagueData(leagueId);
      if (res.success && res.data) {
        setLeague(res.data.league);
        setSchedule(res.data.schedule || []);
        setTeams(res.data.teams || []);
      }
    } catch (err) {
      setErrorMessage(err.response?.data?.message || "Failed to load league data");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (leagueId) loadData();
  }, [leagueId]);

  // Handle Random Generation & In-Place Regeneration
  const handleGenerate = async (force = false) => {
    try {
      setLoading(true);
      setErrorMessage("");
      const res = await generateRandomFixtures(leagueId, force);
      if (res.success) {
        setGenerationSummary(res.data);
        await loadData(); // Reload updated schedule
      }
    } catch (err) {
      const msg = err.response?.data?.message || "Generation failed";
      setErrorMessage(msg);
      
      // If error indicates protected matches, prompt admin
      if (err.response?.data?.protectedFixtures) {
        alert(
          `Cannot regenerate: ${err.response.data.protectedFixtures} match(es) already have recorded scores or are COMPLETED!`
        );
      }
    } finally {
      setLoading(false);
    }
  };

  // Open Edit Modal
  const openEditModal = (fixture) => {
    setEditingFixture(fixture);
    setEditFormData({
      homeTeam: fixture.homeTeam?._id || "",
      awayTeam: fixture.awayTeam?._id || "",
      round: fixture.round,
      kickoffTime: fixture.kickoffTime ? new Date(fixture.kickoffTime).toISOString().slice(0, 16) : "",
      field: fixture.field || "Field 1",
      venue: fixture.venue || "Main Stadium",
    });
  };

  // Save Manual Changes
  const handleSaveEdit = async (e) => {
    e.preventDefault();
    try {
      setLoading(true);
      await updateFixtureManually(leagueId, editingFixture._id, editFormData);
      setEditingFixture(null);
      await loadData();
    } catch (err) {
      alert(err.response?.data?.message || "Failed to update fixture");
    } finally {
      setLoading(false);
    }
  };

  // Current round matches
  const currentRoundData = schedule.find((s) => s.round === selectedRound);
  const currentMatches = currentRoundData?.matches || [];

  // Detect which team has a BYE in the selected round (for odd teams)
  const playingTeamIds = new Set();
  currentMatches.forEach((m) => {
    if (m.homeTeam?._id) playingTeamIds.add(m.homeTeam._id.toString());
    if (m.awayTeam?._id) playingTeamIds.add(m.awayTeam._id.toString());
  });
  const byeTeams = teams.filter((t) => !playingTeamIds.has(t._id.toString()));

  return (
    <div style={{ padding: "24px", maxWidth: "1200px", margin: "0 auto", fontFamily: "sans-serif" }}>
      {/* Top Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "20px" }}>
        <div>
          <h1 style={{ margin: "0 0 8px 0" }}>{league?.name || "League Management"}</h1>
          <p style={{ margin: 0, color: "#666" }}>
            Season: {league?.season} | Format: {league?.fixtureFormat || "ROUND_ROBIN"} ({league?.numberOfRounds === 2 ? "Double" : "Single"} Round Robin)
          </p>
        </div>

        {/* Action Buttons */}
        <div style={{ display: "flex", gap: "12px" }}>
          <button
            onClick={() => handleGenerate(false)}
            disabled={loading}
            style={{
              padding: "10px 18px",
              backgroundColor: "#2563eb",
              color: "#fff",
              border: "none",
              borderRadius: "6px",
              cursor: "pointer",
              fontWeight: "600",
            }}
          >
            {schedule.length > 0 ? "⚡ Regenerate Random Fixtures" : "⚡ Generate Random Fixtures"}
          </button>
        </div>
      </div>

      {/* Error Alert */}
      {errorMessage && (
        <div style={{ padding: "12px", backgroundColor: "#fee2e2", color: "#991b1b", borderRadius: "6px", marginBottom: "16px" }}>
          {errorMessage}
        </div>
      )}

      {/* Generation Audit Banner */}
      {generationSummary && (
        <div style={{ padding: "12px 16px", backgroundColor: "#ecfdf5", border: "1px solid #10b981", borderRadius: "6px", marginBottom: "20px" }}>
          <strong>✓ Schedule Generated Successfully:</strong>{" "}
          {generationSummary.rounds} Rounds | {generationSummary.fixtures} Fixtures |{" "}
          <span style={{ color: "#047857" }}>Updated in-place: {generationSummary.updated}</span> |{" "}
          <span style={{ color: "#2563eb" }}>Created: {generationSummary.created}</span>
          {generationSummary.manualFixturesPreserved > 0 && (
            <span style={{ marginLeft: "8px", color: "#d97706" }}>
              ({generationSummary.manualFixturesPreserved} Manual Fixtures Protected)
            </span>
          )}
        </div>
      )}

      {/* Round Navigation Tabs */}
      {schedule.length > 0 && (
        <div style={{ display: "flex", gap: "8px", overflowX: "auto", paddingBottom: "12px", borderBottom: "1px solid #e5e7eb", marginBottom: "20px" }}>
          {schedule.map((r) => (
            <button
              key={r.round}
              onClick={() => setSelectedRound(r.round)}
              style={{
                padding: "8px 16px",
                borderRadius: "20px",
                border: "none",
                cursor: "pointer",
                backgroundColor: selectedRound === r.round ? "#1e293b" : "#f1f5f9",
                color: selectedRound === r.round ? "#ffffff" : "#475569",
                fontWeight: selectedRound === r.round ? "600" : "400",
              }}
            >
              {r.roundName}
            </button>
          ))}
        </div>
      )}

      {/* Virtual BYE Notification */}
      {byeTeams.length > 0 && (
        <div style={{ padding: "10px 14px", backgroundColor: "#fef3c7", color: "#92400e", borderRadius: "6px", marginBottom: "16px" }}>
          <strong>BYE this round:</strong> {byeTeams.map((t) => t.teamName).join(", ")}
        </div>
      )}

      {/* Fixtures List */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(350px, 1fr))", gap: "16px" }}>
        {currentMatches.map((fix) => (
          <div
            key={fix._id}
            style={{
              border: "1px solid #e2e8f0",
              borderRadius: "8px",
              padding: "16px",
              backgroundColor: "#ffffff",
              boxShadow: "0 1px 3px rgba(0,0,0,0.05)",
            }}
          >
            {/* Slot & Status Header */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
              <span style={{ fontSize: "12px", fontWeight: "600", color: "#64748b" }}>
                {fix.field || "Field 1"} • {fix.kickoffTime ? new Date(fix.kickoffTime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "TBD"}
              </span>

              {/* Source Badge */}
              <span
                style={{
                  fontSize: "11px",
                  padding: "2px 8px",
                  borderRadius: "12px",
                  backgroundColor: fix.fixtureSource === "MANUAL" ? "#ffedd5" : "#e0f2fe",
                  color: fix.fixtureSource === "MANUAL" ? "#c2410c" : "#0369a1",
                  fontWeight: "bold",
                }}
              >
                {fix.fixtureSource === "MANUAL" ? "MANUAL" : "GENERATED"}
              </span>
            </div>

            {/* Teams Matchup */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "16px" }}>
              <div style={{ flex: 1, textAlign: "left", fontWeight: "600" }}>{fix.homeTeam?.teamName || "TBD"}</div>
              <div style={{ padding: "0 12px", color: "#94a3b8", fontWeight: "bold" }}>vs</div>
              <div style={{ flex: 1, textAlign: "right", fontWeight: "600" }}>{fix.awayTeam?.teamName || "TBD"}</div>
            </div>

            {/* Footer with Edit Button */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderTop: "1px solid #f1f5f9", paddingTop: "10px" }}>
              <span style={{ fontSize: "12px", color: "#64748b" }}>{fix.venue}</span>
              <button
                onClick={() => openEditModal(fix)}
                style={{
                  padding: "4px 10px",
                  fontSize: "12px",
                  border: "1px solid #cbd5e1",
                  borderRadius: "4px",
                  backgroundColor: "#ffffff",
                  cursor: "pointer",
                }}
              >
                ✏️ Edit Match
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* Manual Edit Modal */}
      {editingFixture && (
        <div style={{ position: "fixed", inset: 0, backgroundColor: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}>
          <div style={{ backgroundColor: "#ffffff", padding: "24px", borderRadius: "8px", width: "420px" }}>
            <h3>Manual Fixture Edit</h3>
            <p style={{ fontSize: "12px", color: "#64748b" }}>
              Editing this fixture will tag it as <strong>MANUAL</strong> and protect it from being overwritten during future random generations.
            </p>

            <form onSubmit={handleSaveEdit}>
              <div style={{ marginBottom: "12px" }}>
                <label style={{ display: "block", fontSize: "12px", marginBottom: "4px" }}>Home Team</label>
                <select
                  value={editFormData.homeTeam}
                  onChange={(e) => setEditFormData({ ...editFormData, homeTeam: e.target.value })}
                  style={{ width: "100%", padding: "8px", borderRadius: "4px", border: "1px solid #cbd5e1" }}
                  required
                >
                  <option value="">Select Home Team</option>
                  {teams.map((t) => (
                    <option key={t._id} value={t._id}>{t.teamName}</option>
                  ))}
                </select>
              </div>

              <div style={{ marginBottom: "12px" }}>
                <label style={{ display: "block", fontSize: "12px", marginBottom: "4px" }}>Away Team</label>
                <select
                  value={editFormData.awayTeam}
                  onChange={(e) => setEditFormData({ ...editFormData, awayTeam: e.target.value })}
                  style={{ width: "100%", padding: "8px", borderRadius: "4px", border: "1px solid #cbd5e1" }}
                  required
                >
                  <option value="">Select Away Team</option>
                  {teams.map((t) => (
                    <option key={t._id} value={t._id}>{t.teamName}</option>
                  ))}
                </select>
              </div>

              <div style={{ marginBottom: "12px" }}>
                <label style={{ display: "block", fontSize: "12px", marginBottom: "4px" }}>Kickoff Date & Time</label>
                <input
                  type="datetime-local"
                  value={editFormData.kickoffTime}
                  onChange={(e) => setEditFormData({ ...editFormData, kickoffTime: e.target.value })}
                  style={{ width: "100%", padding: "8px", borderRadius: "4px", border: "1px solid #cbd5e1" }}
                  required
                />
              </div>

              <div style={{ marginBottom: "16px" }}>
                <label style={{ display: "block", fontSize: "12px", marginBottom: "4px" }}>Field / Pitch</label>
                <input
                  type="text"
                  value={editFormData.field}
                  onChange={(e) => setEditFormData({ ...editFormData, field: e.target.value })}
                  style={{ width: "100%", padding: "8px", borderRadius: "4px", border: "1px solid #cbd5e1" }}
                />
              </div>

              <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
                <button
                  type="button"
                  onClick={() => setEditingFixture(null)}
                  style={{ padding: "8px 14px", border: "none", backgroundColor: "#f1f5f9", borderRadius: "4px", cursor: "pointer" }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={loading}
                  style={{ padding: "8px 14px", border: "none", backgroundColor: "#2563eb", color: "#fff", borderRadius: "4px", cursor: "pointer" }}
                >
                  Save Changes
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
```

---

## 6. Key Edge Cases Handled for Frontend

1. **Unlimited Regeneration without Record Ballooning:**
   - Every time the user clicks "Regenerate Random Fixtures", the response shows `updated: X, created: 0`. No duplicate rows will appear in the UI or database.
2. **Virtual BYE Handling:**
   - Odd teams receive a BYE. The backend **never** returns a fake dummy team fixture document.
   - The UI computes `byeTeams` by checking which league teams are not playing in `schedule.matches` for the active round and displays a clean banner.
3. **Manual Match Preservation:**
   - When an admin saves changes in the edit modal, the match is updated with `fixtureSource: "MANUAL"`.
   - On future regenerations, the match retains its customized matchup/time while other matches shuffle.
4. **Completed Match Protection:**
   - If a fixture is marked as `COMPLETED` or scores have been recorded, the backend rejects blind regeneration with HTTP 400 (`protectedFixtures: count`). The frontend should catch this and inform the user.
