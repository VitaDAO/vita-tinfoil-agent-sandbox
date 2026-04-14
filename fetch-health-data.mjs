import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { decryptHealthData } from "./decrypt.mjs";

const WORKSPACE_DIR = "/home/user/.openclaw/workspace";
const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

const MISSING_TABLE_CODES = new Set(["PGRST205", "42P01"]);
const CLINICAL_CATEGORY = "clinical";
const BIOMARKER_CATEGORY = "biomarker";
const WEARABLE_CATEGORY = "wearable";

const WEARABLE_CATEGORY_MAP = {
  deep_sleep: "sleep",
  rem_sleep: "sleep",
  light_sleep: "sleep",
  awake_time: "sleep",
  total_sleep: "sleep",
  sleep_efficiency: "sleep",
  sleep_score: "sleep",
  sleep_performance: "sleep",
  sleep_consistency: "sleep",
  sleep_rem: "sleep",
  sleep_deep: "sleep",
  sleep_light: "sleep",
  sleep_awake: "sleep",
  bedtime_hour: "sleep",
  wake_hour: "sleep",
  respiratory_rate: "sleep",
  hrv: "recovery",
  resting_hr: "recovery",
  spo2: "recovery",
  skin_temp: "recovery",
  body_temp_deviation: "recovery",
  recovery_score: "recovery",
  readiness_score: "recovery",
  heart_pulse: "recovery",
  stress_high_duration: "stress",
  recovery_high_duration: "stress",
  stress_summary: "stress",
  resilience_level: "stress",
  resilience_sleep_recovery: "stress",
  resilience_daytime_recovery: "stress",
  resilience_stress: "stress",
  steps: "activity",
  calories: "activity",
  calories_active: "activity",
  active_calories: "activity",
  calories_burned: "activity",
  day_calories: "activity",
  day_strain: "activity",
  day_avg_hr: "activity",
  day_max_hr: "activity",
  strain_score: "activity",
  activity_score: "activity",
  sedentary_time: "activity",
  distance: "activity",
  elevation: "activity",
  light_activity_duration: "activity",
  moderate_activity_duration: "activity",
  intense_activity_duration: "activity",
  activity_hr_average: "activity",
  activity_hr_min: "activity",
  activity_hr_max: "activity",
  workout_calories: "training",
  workout_intensity: "training",
  workout_avg_hr: "training",
  workout_max_hr: "training",
  workout_distance: "training",
  hr_zone_0: "training",
  hr_zone_1: "training",
  hr_zone_2: "training",
  hr_zone_3: "training",
  hr_zone_4: "training",
  hr_zone_5: "training",
  weight: "body",
  fat_percent: "body",
  fat_free_mass: "body",
  fat_mass_weight: "body",
  muscle_mass: "body",
  lean_mass_percent: "body",
  bone_mass: "body",
  hydration: "body",
  height: "body",
  visceral_fat: "body",
  vo2_max: "cardiovascular",
  cardiovascular_age: "cardiovascular",
  vascular_age: "cardiovascular",
  pulse_wave_velocity: "cardiovascular",
  systolic_bp: "cardiovascular",
  diastolic_bp: "cardiovascular",
  body_temperature: "cardiovascular",
};

function ensureSupabaseConfig() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be configured in the sandbox.");
  }
}

function buildInFilter(values) {
  return `in.(${values.map((value) => `"${String(value).replaceAll('"', '\\"')}"`).join(",")})`;
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isMissingTable(status, payload) {
  return status === 404 || (payload && typeof payload === "object" && MISSING_TABLE_CODES.has(payload.code));
}

async function queryRows(table, { select = "*", filters = {}, order, limit } = {}) {
  ensureSupabaseConfig();

  const url = new URL(`${SUPABASE_URL}/rest/v1/${table}`);
  url.searchParams.set("select", select);

  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, value);
    }
  }

  if (order) {
    url.searchParams.set("order", order);
  }
  if (limit) {
    url.searchParams.set("limit", String(limit));
  }

  const response = await fetch(url, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });

  const bodyText = await response.text();
  const payload = safeJsonParse(bodyText);

  if (!response.ok) {
    if (isMissingTable(response.status, payload)) {
      return null;
    }
    throw new Error(`Supabase query failed for ${table}: ${response.status} ${bodyText.slice(0, 240)}`);
  }

  return Array.isArray(payload) ? payload : [];
}

async function queryFirstRow(table, options) {
  const rows = await queryRows(table, { ...options, limit: 1 });
  if (rows === null) {
    return null;
  }
  return rows[0];
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asNumberOrNull(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function formatDate(value) {
  return typeof value === "string" && value.length >= 10 ? value.slice(0, 10) : "?";
}

function getMetricCategory(metricType) {
  return WEARABLE_CATEGORY_MAP[metricType] || "other";
}

async function fetchEncryptedProfile(userId, keySession) {
  const row = await queryFirstRow("profiles_encrypted", {
    select: "user_id,encrypted_payload,encryption_nonce,created_at,updated_at",
    filters: { user_id: `eq.${userId}` },
  });
  if (row === null) {
    return null;
  }
  if (!row) {
    return undefined;
  }

  let payload = {};
  if (row?.encrypted_payload && row?.encryption_nonce) {
    payload = await decryptHealthData({
      session: keySession,
      category: CLINICAL_CATEGORY,
      encrypted_payload: row.encrypted_payload,
      encryption_nonce: row.encryption_nonce,
    });
  }

  const chronicRow = await queryFirstRow("biomarker_readings_encrypted", {
    select: "recorded_at,encrypted_payload,encryption_nonce",
    filters: {
      user_id: `eq.${userId}`,
      category: `eq.${CLINICAL_CATEGORY}`,
      record_type: "eq.chronic_conditions",
    },
    order: "recorded_at.desc",
  });

  let chronicConditions = null;
  if (chronicRow?.encrypted_payload && chronicRow?.encryption_nonce) {
    const chronicPayload = await decryptHealthData({
      session: keySession,
      category: CLINICAL_CATEGORY,
      encrypted_payload: chronicRow.encrypted_payload,
      encryption_nonce: chronicRow.encryption_nonce,
    });
    chronicConditions = asArray(chronicPayload.conditions);
  }

  return {
    display_name: payload.display_name ?? null,
    bio: payload.bio ?? null,
    avatar_url: payload.avatar_url ?? null,
    chronic_conditions: chronicConditions,
    created_at: row?.created_at ?? null,
    updated_at: row?.updated_at ?? null,
  };
}

async function fetchPlainProfile(userId) {
  const row = await queryFirstRow("profiles", {
    select: "display_name,bio,chronic_conditions,created_at,updated_at",
    filters: { user_id: `eq.${userId}` },
  });
  if (row === null) {
    return null;
  }
  if (!row) {
    return null;
  }

  return {
    display_name: row?.display_name ?? null,
    bio: row?.bio ?? null,
    chronic_conditions: asArray(row?.chronic_conditions),
    created_at: row?.created_at ?? null,
    updated_at: row?.updated_at ?? null,
  };
}

async function fetchProfile(userId, keySession) {
  return (await fetchEncryptedProfile(userId, keySession)) ?? (await fetchPlainProfile(userId)) ?? null;
}

async function fetchEncryptedPreferences(userId, keySession) {
  const row = await queryFirstRow("user_preferences_encrypted", {
    select: "user_id,unit_system,dashboard_tour_completed,encrypted_payload,encryption_nonce,created_at,updated_at",
    filters: { user_id: `eq.${userId}` },
  });
  if (row === null) {
    return null;
  }
  if (!row) {
    return undefined;
  }

  let payload = {};
  if (row?.encrypted_payload && row?.encryption_nonce) {
    payload = await decryptHealthData({
      session: keySession,
      category: CLINICAL_CATEGORY,
      encrypted_payload: row.encrypted_payload,
      encryption_nonce: row.encryption_nonce,
    });
  }

  return {
    goals: asArray(payload.goals),
    sex: payload.sex ?? null,
    experience_level: payload.experience_level ?? null,
    birth_year: asNumberOrNull(payload.birth_year),
    unit_system: row?.unit_system ?? "conventional",
    created_at: row?.created_at ?? null,
    updated_at: row?.updated_at ?? null,
  };
}

async function fetchPlainPreferences(userId) {
  const row = await queryFirstRow("user_preferences", {
    select: "goals,sex,experience_level,birth_year,unit_system,created_at,updated_at",
    filters: { user_id: `eq.${userId}` },
  });
  if (row === null) {
    return null;
  }
  if (!row) {
    return null;
  }

  return {
    goals: asArray(row?.goals),
    sex: row?.sex ?? null,
    experience_level: row?.experience_level ?? null,
    birth_year: asNumberOrNull(row?.birth_year),
    unit_system: row?.unit_system ?? "conventional",
    created_at: row?.created_at ?? null,
    updated_at: row?.updated_at ?? null,
  };
}

async function fetchPreferences(userId, keySession) {
  return (await fetchEncryptedPreferences(userId, keySession)) ?? (await fetchPlainPreferences(userId)) ?? null;
}

async function fetchEncryptedBiomarkers(userId, keySession) {
  const rows = await queryRows("biomarker_readings_encrypted", {
    select: "id,record_type,source,recorded_at,encrypted_payload,encryption_nonce",
    filters: { user_id: `eq.${userId}`, category: `eq.${BIOMARKER_CATEGORY}` },
    order: "recorded_at.desc",
    limit: 20,
  });
  if (rows === null) {
    return null;
  }

  const biomarkers = [];
  for (const row of rows) {
    try {
      const payload = await decryptHealthData({
        session: keySession,
        category: BIOMARKER_CATEGORY,
        encrypted_payload: row.encrypted_payload,
        encryption_nonce: row.encryption_nonce,
      });
      biomarkers.push({
        id: row.id,
        name: payload.name ?? row.record_type ?? "Biomarker",
        value: payload.value ?? null,
        unit: payload.unit ?? "",
        recorded_at: row.recorded_at,
        source: row.source ?? null,
        biomarker_id: payload.biomarker_id ?? null,
        lab_upload_id: payload.lab_upload_id ?? null,
      });
    } catch (error) {
      console.warn("[health-data] Failed to decrypt biomarker row:", row.id, error?.message || error);
    }
  }

  return biomarkers;
}

async function fetchPlainBiomarkers(userId) {
  const rows = await queryRows("biomarker_readings", {
    select: "id,name,value,unit,recorded_at,source",
    filters: { user_id: `eq.${userId}` },
    order: "recorded_at.desc",
    limit: 20,
  });
  if (rows === null) {
    return null;
  }
  return rows || [];
}

async function fetchBiomarkers(userId, keySession) {
  return (await fetchEncryptedBiomarkers(userId, keySession)) ?? (await fetchPlainBiomarkers(userId)) ?? [];
}

async function fetchEncryptedProtocols(userId, keySession) {
  const protocolRows = await queryRows("user_protocols_encrypted", {
    select: "id,user_id,status,start_date,end_date,encrypted_payload,encryption_nonce,created_at,updated_at",
    filters: { user_id: `eq.${userId}`, status: "eq.active" },
    order: "created_at.desc",
    limit: 3,
  });
  if (protocolRows === null) {
    return null;
  }

  const protocolIds = protocolRows.map((row) => row.id).filter(Boolean);
  const componentRows = protocolIds.length > 0
    ? (await queryRows("protocol_components_encrypted", {
      select: "id,protocol_id,category,encrypted_payload,encryption_nonce,created_at",
      filters: { protocol_id: buildInFilter(protocolIds) },
      order: "created_at.asc",
    })) || []
    : [];

  const componentsByProtocol = new Map();
  for (const row of componentRows) {
    try {
      const payload = await decryptHealthData({
        session: keySession,
        category: CLINICAL_CATEGORY,
        encrypted_payload: row.encrypted_payload,
        encryption_nonce: row.encryption_nonce,
      });
      const list = componentsByProtocol.get(row.protocol_id) || [];
      list.push({
        title: payload.title ?? "",
        category: row.category ?? null,
        dosage: payload.dosage ?? null,
        unit: payload.unit ?? null,
        timing: payload.timing ?? null,
        frequency: payload.frequency ?? null,
      });
      componentsByProtocol.set(row.protocol_id, list);
    } catch (error) {
      console.warn("[health-data] Failed to decrypt protocol component:", row.id, error?.message || error);
    }
  }

  const protocols = [];
  for (const row of protocolRows) {
    try {
      const payload = await decryptHealthData({
        session: keySession,
        category: CLINICAL_CATEGORY,
        encrypted_payload: row.encrypted_payload,
        encryption_nonce: row.encryption_nonce,
      });
      protocols.push({
        id: row.id,
        name: payload.name ?? "",
        goal: payload.goal ?? null,
        start_date: row.start_date,
        protocol_components: componentsByProtocol.get(row.id) || [],
      });
    } catch (error) {
      console.warn("[health-data] Failed to decrypt protocol:", row.id, error?.message || error);
    }
  }

  return protocols;
}

async function fetchPlainProtocols(userId) {
  const protocolRows = await queryRows("user_protocols", {
    select: "id,name,goal,start_date,status",
    filters: { user_id: `eq.${userId}`, status: "eq.active" },
    order: "created_at.desc",
    limit: 3,
  });
  if (protocolRows === null) {
    return null;
  }

  const protocolIds = protocolRows.map((row) => row.id).filter(Boolean);
  const componentRows = protocolIds.length > 0
    ? (await queryRows("protocol_components", {
      select: "protocol_id,title,category,dosage,unit,timing,frequency",
      filters: { protocol_id: buildInFilter(protocolIds) },
      order: "created_at.asc",
    })) || []
    : [];

  const componentsByProtocol = new Map();
  for (const row of componentRows) {
    const list = componentsByProtocol.get(row.protocol_id) || [];
    list.push(row);
    componentsByProtocol.set(row.protocol_id, list);
  }

  return protocolRows.map((row) => ({
    ...row,
    protocol_components: componentsByProtocol.get(row.id) || [],
  }));
}

async function fetchProtocols(userId, keySession) {
  return (await fetchEncryptedProtocols(userId, keySession)) ?? (await fetchPlainProtocols(userId)) ?? [];
}

async function fetchEncryptedWearables(userId, keySession) {
  const rows = await queryRows("wearable_readings_encrypted", {
    select: "id,user_id,source,record_type,recorded_at,created_at,encrypted_payload,encryption_nonce",
    filters: { user_id: `eq.${userId}` },
    order: "recorded_at.desc",
    limit: 30,
  });
  if (rows === null) {
    return null;
  }

  const wearables = [];
  for (const row of rows) {
    try {
      const payload = await decryptHealthData({
        session: keySession,
        category: WEARABLE_CATEGORY,
        encrypted_payload: row.encrypted_payload,
        encryption_nonce: row.encryption_nonce,
      });
      wearables.push({
        id: row.id,
        source: row.source,
        category: getMetricCategory(row.record_type),
        metric_type: row.record_type,
        value: payload.value ?? null,
        unit: payload.unit ?? "",
        recorded_at: row.recorded_at,
      });
    } catch (error) {
      console.warn("[health-data] Failed to decrypt wearable row:", row.id, error?.message || error);
    }
  }

  return wearables;
}

async function fetchPlainWearables(userId) {
  const rows = await queryRows("wearable_readings", {
    select: "id,category,metric_type,value,unit,source,recorded_at",
    filters: { user_id: `eq.${userId}` },
    order: "recorded_at.desc",
    limit: 30,
  });
  if (rows === null) {
    return null;
  }
  return rows || [];
}

async function fetchWearables(userId, keySession) {
  return (await fetchEncryptedWearables(userId, keySession)) ?? (await fetchPlainWearables(userId)) ?? [];
}

async function fetchEncryptedWorkouts(userId, keySession) {
  const rows = await queryRows("workout_sessions_encrypted", {
    select: "id,user_id,source,started_at,created_at,encrypted_payload,encryption_nonce",
    filters: { user_id: `eq.${userId}` },
    order: "started_at.desc",
    limit: 10,
  });
  if (rows === null) {
    return null;
  }

  const workouts = [];
  for (const row of rows) {
    try {
      const payload = await decryptHealthData({
        session: keySession,
        category: WEARABLE_CATEGORY,
        encrypted_payload: row.encrypted_payload,
        encryption_nonce: row.encryption_nonce,
      });
      workouts.push({
        id: row.id,
        source: row.source,
        started_at: row.started_at,
        workout_type: payload.workout_type ?? "Workout",
        duration_minutes: payload.duration_minutes ?? null,
        calories: payload.calories ?? null,
        avg_heart_rate: payload.avg_heart_rate ?? null,
        strain: payload.strain ?? null,
      });
    } catch (error) {
      console.warn("[health-data] Failed to decrypt workout row:", row.id, error?.message || error);
    }
  }

  return workouts;
}

async function fetchPlainWorkouts(userId) {
  const rows = await queryRows("workout_sessions", {
    select: "id,workout_type,duration_minutes,calories,avg_heart_rate,strain,source,started_at",
    filters: { user_id: `eq.${userId}` },
    order: "started_at.desc",
    limit: 10,
  });
  if (rows === null) {
    return null;
  }
  return rows || [];
}

async function fetchWorkouts(userId, keySession) {
  return (await fetchEncryptedWorkouts(userId, keySession)) ?? (await fetchPlainWorkouts(userId)) ?? [];
}

async function fetchEncryptedCompositeHealthScore(userId, keySession) {
  const row = await queryFirstRow("composite_health_scores_encrypted", {
    select: "score_date,computed_at,encrypted_payload,encryption_nonce",
    filters: { user_id: `eq.${userId}` },
    order: "score_date.desc",
  });
  if (row === null) {
    return null;
  }
  if (!row) {
    return undefined;
  }
  if (!row?.encrypted_payload || !row?.encryption_nonce) {
    return null;
  }

  const payload = await decryptHealthData({
    session: keySession,
    category: CLINICAL_CATEGORY,
    encrypted_payload: row.encrypted_payload,
    encryption_nonce: row.encryption_nonce,
  });

  return {
    score: payload.score ?? null,
    data_coverage_pct: payload.data_coverage_pct ?? null,
    domain_scores: payload.domain_scores ?? null,
    score_date: row.score_date,
    computed_at: row.computed_at,
  };
}

async function fetchPlainCompositeHealthScore(userId) {
  const row = await queryFirstRow("composite_health_scores", {
    select: "score,data_coverage_pct,domain_scores,score_date,computed_at",
    filters: { user_id: `eq.${userId}` },
    order: "score_date.desc",
  });
  if (row === null || !row) {
    return null;
  }
  return row;
}

async function fetchCompositeHealthScore(userId, keySession) {
  return (await fetchEncryptedCompositeHealthScore(userId, keySession)) ?? (await fetchPlainCompositeHealthScore(userId)) ?? null;
}

async function fetchEncryptedBioAge(userId, keySession) {
  const row = await queryFirstRow("bio_age_scores_encrypted", {
    select: "clock_name,computed_at,year,week_number,encrypted_payload,encryption_nonce",
    filters: { user_id: `eq.${userId}`, clock_name: "eq.phenoage" },
    order: "year.desc,week_number.desc",
  });
  if (row === null) {
    return null;
  }
  if (!row) {
    return undefined;
  }
  if (!row?.encrypted_payload || !row?.encryption_nonce) {
    return null;
  }

  const payload = await decryptHealthData({
    session: keySession,
    category: CLINICAL_CATEGORY,
    encrypted_payload: row.encrypted_payload,
    encryption_nonce: row.encryption_nonce,
  });

  return {
    bio_age: payload.bio_age ?? null,
    chronological_age: payload.chronological_age ?? null,
    age_difference: payload.age_difference ?? null,
    biomarker_count: payload.biomarker_count ?? null,
    computed_at: row.computed_at,
  };
}

async function fetchPlainBioAge(userId) {
  const row = await queryFirstRow("bio_age_scores", {
    select: "bio_age,chronological_age,age_difference,biomarker_count,computed_at",
    filters: { user_id: `eq.${userId}` },
    order: "computed_at.desc",
  });
  if (row === null || !row) {
    return null;
  }
  return row;
}

async function fetchBioAge(userId, keySession) {
  return (await fetchEncryptedBioAge(userId, keySession)) ?? (await fetchPlainBioAge(userId)) ?? null;
}

async function fetchEncryptedAgingVelocity(userId, keySession) {
  const row = await queryFirstRow("aging_velocity_scores_encrypted", {
    select: "computed_at,encrypted_payload,encryption_nonce",
    filters: { user_id: `eq.${userId}` },
    order: "computed_at.desc",
  });
  if (row === null) {
    return null;
  }
  if (!row) {
    return undefined;
  }
  if (!row?.encrypted_payload || !row?.encryption_nonce) {
    return null;
  }

  const payload = await decryptHealthData({
    session: keySession,
    category: CLINICAL_CATEGORY,
    encrypted_payload: row.encrypted_payload,
    encryption_nonce: row.encryption_nonce,
  });

  return {
    velocity: payload.velocity ?? null,
    span_days: payload.span_days ?? null,
    data_points: payload.data_points ?? null,
    computed_at: row.computed_at,
  };
}

async function fetchPlainAgingVelocity(userId) {
  const row = await queryFirstRow("aging_velocity_scores", {
    select: "velocity,span_days,data_points,computed_at",
    filters: { user_id: `eq.${userId}` },
    order: "computed_at.desc",
  });
  if (row === null || !row) {
    return null;
  }
  return row;
}

async function fetchAgingVelocity(userId, keySession) {
  return (await fetchEncryptedAgingVelocity(userId, keySession)) ?? (await fetchPlainAgingVelocity(userId)) ?? null;
}

export async function fetchHealthContext({ userId, keySession }) {
  const [
    profile,
    preferences,
    biomarkers,
    protocols,
    wearables,
    workouts,
    health_score,
    bio_age,
    aging_velocity,
  ] = await Promise.all([
    fetchProfile(userId, keySession),
    fetchPreferences(userId, keySession),
    fetchBiomarkers(userId, keySession),
    fetchProtocols(userId, keySession),
    fetchWearables(userId, keySession),
    fetchWorkouts(userId, keySession),
    fetchCompositeHealthScore(userId, keySession),
    fetchBioAge(userId, keySession),
    fetchAgingVelocity(userId, keySession),
  ]);

  return {
    profile,
    preferences,
    biomarkers: biomarkers || [],
    protocols: protocols || [],
    wearables: wearables || [],
    workouts: workouts || [],
    health_score,
    bio_age,
    aging_velocity,
  };
}

function buildUserHeader(profile, preferences) {
  let markdown = "# User\n\n";

  if (!profile && !preferences) {
    return markdown;
  }

  if (profile?.display_name) {
    markdown += `- **Name**: ${profile.display_name}\n`;
  }

  if (preferences?.birth_year) {
    const age = new Date().getFullYear() - Number(preferences.birth_year);
    if (age > 0 && age < 150) {
      markdown += `- **Age**: ${age}\n`;
    }
  }

  if (preferences?.sex) {
    markdown += `- **Sex**: ${preferences.sex}\n`;
  }

  if (preferences?.experience_level) {
    markdown += `- **Experience**: ${preferences.experience_level}\n`;
  }

  if (profile?.chronic_conditions?.length) {
    markdown += `- **Chronic conditions**: ${profile.chronic_conditions.join(", ")}\n`;
  }

  if (preferences?.goals?.length) {
    markdown += `- **Goals**: ${preferences.goals.join(", ")}\n`;
  }

  markdown += "\n";
  return markdown;
}

function buildHealthSection({ biomarkers, protocols, wearables, workouts, health_score, bio_age, aging_velocity, supermemory }) {
  let markdown = "# Health Data\n\n";

  if (health_score) {
    markdown += "## Health Score\n\n";
    markdown += `- Score: ${health_score.score ?? "?"}/100 (coverage: ${health_score.data_coverage_pct ?? "?"}%)\n`;
    markdown += `- Date: ${formatDate(health_score.score_date)}\n`;
    if (health_score.domain_scores && typeof health_score.domain_scores === "object") {
      for (const [domain, value] of Object.entries(health_score.domain_scores)) {
        const score = value && typeof value === "object" ? value.score ?? JSON.stringify(value) : value;
        markdown += `  - ${domain}: ${score}\n`;
      }
    }
    markdown += "\n";
  }

  if (bio_age) {
    markdown += "## Bio Age\n\n";
    markdown += `- Bio Age: ${bio_age.bio_age ?? "?"} (chronological: ${bio_age.chronological_age ?? "?"})\n`;
    markdown += `- Difference: ${bio_age.age_difference ?? "?"} years\n`;
    markdown += `- Based on: ${bio_age.biomarker_count ?? "?"} biomarkers\n`;
    markdown += `- Computed: ${formatDate(bio_age.computed_at)}\n\n`;
  }

  if (aging_velocity) {
    markdown += "## Aging Velocity\n\n";
    markdown += `- Velocity: ${aging_velocity.velocity ?? "?"} (1.0 = normal, <1.0 = slower aging)\n`;
    markdown += `- Span: ${aging_velocity.span_days ?? "?"} days, ${aging_velocity.data_points ?? "?"} data points\n\n`;
  }

  if (biomarkers?.length) {
    markdown += "## Recent Biomarkers\n\n";
    const seen = new Set();
    for (const biomarker of biomarkers) {
      const key = `${biomarker.name}_${formatDate(biomarker.recorded_at)}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      markdown += `- ${biomarker.name}: ${biomarker.value} ${biomarker.unit || ""} (${formatDate(biomarker.recorded_at)})\n`;
    }
    markdown += "\n";
  }

  if (wearables?.length) {
    markdown += "## Recent Wearable Data\n\n";
    for (const wearable of wearables) {
      markdown += `- [${wearable.category || "other"}] ${wearable.metric_type || ""}: ${wearable.value ?? ""} ${wearable.unit || ""} (${formatDate(wearable.recorded_at)}, ${wearable.source || ""})\n`;
    }
    markdown += "\n";
  }

  if (workouts?.length) {
    markdown += "## Recent Workouts\n\n";
    for (const workout of workouts) {
      markdown += `- ${workout.workout_type || "Workout"} (${formatDate(workout.started_at)}): ${workout.duration_minutes ?? "?"}min`;
      if (workout.calories) {
        markdown += `, ${workout.calories}cal`;
      }
      if (workout.avg_heart_rate) {
        markdown += `, avg HR ${workout.avg_heart_rate}`;
      }
      if (workout.strain) {
        markdown += `, strain ${workout.strain}`;
      }
      markdown += ` [${workout.source || ""}]\n`;
    }
    markdown += "\n";
  }

  if (protocols?.length) {
    for (const protocol of protocols) {
      markdown += `## Active Protocol: "${protocol.name}"\n\n`;
      markdown += `Goal: ${protocol.goal || "Not specified"} | Started: ${protocol.start_date || "?"}\n\n`;
      for (const component of protocol.protocol_components || []) {
        markdown += `- ${component.title || ""}`;
        if (component.dosage) {
          markdown += ` (${component.dosage}${component.unit || ""})`;
        }
        if (component.timing) {
          markdown += ` -- ${component.timing}`;
        }
        if (component.frequency) {
          markdown += ` [${component.frequency}]`;
        }
        markdown += "\n";
      }
      markdown += "\n";
    }
  }

  if (supermemory) {
    const items = [
      ...asArray(supermemory.static),
      ...asArray(supermemory.memories),
    ].filter(Boolean);

    if (items.length > 0) {
      markdown += "## Relevant Memories\n\n";
      for (const item of items.slice(0, 10)) {
        let text = typeof item === "string" ? item : JSON.stringify(item);
        if (text.length > 500) {
          text = `${text.slice(0, 500)}...`;
        }
        markdown += `- ${text}\n`;
      }
      markdown += "\n";
    }
  }

  return markdown;
}

export function buildUserMarkdown({ profile, preferences, biomarkers, protocols, wearables, workouts, health_score, bio_age, aging_velocity, supermemory }) {
  return buildUserHeader(profile, preferences) + buildHealthSection({
    biomarkers,
    protocols,
    wearables,
    workouts,
    health_score,
    bio_age,
    aging_velocity,
    supermemory,
  });
}

export async function buildAndWriteUserMarkdown({ userId, keySession, supermemory, workspaceDir = WORKSPACE_DIR }) {
  const context = await fetchHealthContext({ userId, keySession });
  const markdown = buildUserMarkdown({ ...context, supermemory });
  writeFileSync(join(workspaceDir, "USER.md"), markdown, "utf-8");
  return { context, markdown };
}
