
// ================================
// Persist last allocation context (server-side)
// ================================

let lastAllocationContext = new Map(); 
// key = user_id
// value = { charityIds, mode }


// ================================
// GLOBAL CACHE
// ================================
let cachedData = null;

// ================================
// RATE LIMITING
// ================================
const RATE_LIMIT = 10;
const WINDOW_MS = 60 * 1000;
const ipStore = new Map();

// ================================
// CORS (FIXED)
// ================================
const corsHeaders = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400"
};

// ================================
// STRICT SYSTEM PROMPT
// ================================
const systemPrompt = `
You are a strict recommendation engine operating only on the Charitable Impact dataset.

Rules:
- You MUST only use DATA provided.
- You MUST NOT invent charities, figures, or reasoning.
- If information is missing, respond: "I do not have that data available."
- You must never generalize beyond the dataset.
- All justifications must be directly grounded in fields inside DATA.
- This dataset represents records from the Charitable Impact platform only.
`;

// ================================
// HELPERS
// ================================
function normalize(value = "") {
  if (Array.isArray(value)) return value.map(v => normalize(v)).join(" ");
  if (typeof value !== "string") return "";
  return value.toLowerCase().replace(/[^a-z]/g, "");
}

function extractAmount(messages) {
  const text = messages.filter(m => m.role === "user").at(-1)?.content || "";

  // Prefer amounts like "$500"
  const dollarMatch = text.match(/\$(\d{2,6})/);
  if (dollarMatch) return parseInt(dollarMatch[1]);

  // Otherwise take the LARGEST number (not user10, user3 etc.)
  const numbers = text.match(/\b\d{1,6}\b/g);
  if (!numbers) return null;

  return Math.max(...numbers.map(n => parseInt(n)));
}


function isAuditRequest(messages) {
  const text = messages.filter(m => m.role === "user").at(-1)?.content?.toLowerCase() || "";
  return text.includes("audit") || text.includes("explain");
}

function extractRequestedCharities(messages, charities) {
  const text = messages.filter(m => m.role === "user").at(-1)?.content?.toLowerCase() || "";

  if (!text.includes(" to ")) return []; // prevent false numeric matches

  // Try to match by charity id pattern like 36, 51, ch_00036
  const idMatches = [
    ...(text.match(/charity\s+(\d{1,4})/g) || []).map(m => m.match(/\d+/)[0]),
    ...(text.match(/foundation\s+(\d{1,4})/g) || []).map(m => m.match(/\d+/)[0])
  ];
  

  const byId = charities.filter(c =>
    idMatches.includes(String(c.id).replace(/^ch_?0*/, "")) ||
    idMatches.includes(String(c.id))
  );

  // Try fuzzy name match
  const byName = charities.filter(c =>
    text.includes(c.name.toLowerCase())
  );

  // Merge and dedupe
  const combined = [...new Map([...byId, ...byName].map(c => [c.id, c])).values()];

  return combined;
}

function allocateEvenly(total, charities, trends, transactions, financials) {
  const per = Math.floor(total / charities.length);

  const MIN = total < charities.length * 10 ? 0 : 10;


let allocations = charities.map(c => {
  const fin = financials?.[c.id]?.at(-1);
  const donors = transactions?.[c.id]?.unique_donors || 0;
  const trend = trends?.[c.id]?.last_12_month_avg || 0;

  const programRatio = fin ? fin.program_spend / fin.expenses : 0;
  const surplus = fin ? fin.revenue - fin.expenses : 0;
  const stability = fin ? (fin.assets - fin.liabilities) : 0;

  const reason = [
    `• Strong program efficiency (${(programRatio * 100).toFixed(1)}% spent directly on programs)`,
    `• Financially stable with surplus of $${surplus.toLocaleString()} and net assets of $${stability.toLocaleString()}`,
    `• High community trust reflected by ${donors} active donors and trend score ${trend}`
  ].join("<br>");

  return {
    id: c.id,
    name: c.name,
    causes_display: c.causes.join(", "),
    popularity_score: c.popularity_score,
    link: c.link || "N/A",
    final_score: c.final_score,
    reason
  };
});

// weighted allocation
const totalScore = allocations.reduce((s, a) => s + a.final_score, 0);

allocations = allocations.map(a => ({
  ...a,
  allocated_amount: Math.max(
    MIN,
    Math.round(total * (a.final_score / totalScore))
  )
}));

// fix rounding diff to keep total exact
const sum = allocations.reduce((s, a) => s + a.allocated_amount, 0);
const diff = total - sum;
if (diff !== 0) allocations[0].allocated_amount += diff;

return allocations;
}

function isAllocationIntent(messages) {
  const text = messages
    .filter(m => m.role === "user")
    .at(-1)?.content?.toLowerCase() || "";

  const keywords = [
    "allocate",
    "donate",
    "donation",
    "$",
    "give",
    "portfolio",
    "charity",
    "foundation",
    "trust"
  ];

  return keywords.some(k => text.includes(k));
}


// ================================
// SIGNAL EXTRACTION
// ================================
function extractSignals(messages, userProfile) {
  const last = messages.filter(m => m.role === "user").at(-1)?.content?.toLowerCase() || "";

  const causes = ["health","education","animals","sports","environment","youth","community"];

  let matchedCauses = causes.filter(c => last.includes(c));
  let usedDefaultCauses = false;

  if (!matchedCauses.length && userProfile?.default_causes?.length) {
    matchedCauses = userProfile.default_causes.map(normalize);
    usedDefaultCauses = true;
  }

  const regions = ["ontario","british columbia","alberta","quebec"];
  let matchedRegions = regions.filter(r => last.includes(r));
  let usedDefaultRegions = false;

  if (!matchedRegions.length && userProfile?.default_regions?.length) {
    matchedRegions = userProfile.default_regions.map(normalize);
    usedDefaultRegions = true;
  }

  return { matchedCauses, matchedRegions, usedDefaultCauses, usedDefaultRegions };
}

// ================================
// SCORING (financial + donors + trends)
// ================================
function scoreCharity(c, trends, transactions, financials) {
  const id = c.id;
  const fin = financials?.[id]?.at(-1);

  const programRatio = fin ? fin.program_spend / fin.expenses : 0;
  const stability = fin ? 1 - Math.min(fin.liabilities / fin.assets, 1) : 0;

  const popularity = c.popularity_score || 0;
  const trend = trends?.[id]?.last_12_month_avg || 0;
  const donors = transactions?.[id]?.unique_donors || 0;

  return (
    popularity * 0.25 +
    trend * 0.25 +
    donors / 20 +
    programRatio * 100 * 0.15 +
    stability * 100 * 0.10
  );
}

// ================================
// RETRIEVAL
// ================================
function retrieveRelevantCharities(signals, charities) {
  const { matchedCauses, matchedRegions } = signals;

  return charities.filter(c => {
    const causeMatch = !matchedCauses.length || matchedCauses.some(mc =>
      normalize(c.causes).includes(normalize(mc))
    );

    const regionMatch = !matchedRegions.length || matchedRegions.some(r =>
      normalize(c.location?.province || "").includes(normalize(r))
    );

    return causeMatch && regionMatch;
  });
}

// ================================
// ALLOCATION (WITH AUDIT FIELDS)
// ================================
function allocateBudget(total, charities, trends, transactions, financials) {
  const totalScore = charities.reduce((s, c) => s + c.final_score, 0);

  return charities.map(c => {
    const fin = financials?.[c.id]?.at(-1);
    const donors = transactions?.[c.id]?.unique_donors || 0;
    const trend = trends?.[c.id]?.last_12_month_avg || 0;

    const programRatio = fin ? fin.program_spend / fin.expenses : 0;
    const surplus = fin ? fin.revenue - fin.expenses : 0;
    const stability = fin ? (fin.assets - fin.liabilities) : 0;

    // These are all factual and traceable to data
    const reason = [
      `• Strong program efficiency (${(programRatio * 100).toFixed(1)}% spent directly on programs)`,
      `• Financially stable with surplus of $${surplus.toLocaleString()} and net assets of $${stability.toLocaleString()}`,
      `• High community trust reflected by ${donors} active donors and trend score ${trend}`
    ].join("<br>");
    

    return {
      id: c.id,
      name: c.name,
      causes_display: c.causes.join(", "),
      popularity_score: c.popularity_score,
      allocated_amount: Math.round(total * (c.final_score / totalScore)),
      link: c.link || "N/A",

      // 👇 Now reason is real analysis, not invented
      reason,

      audit: {
        revenue: fin?.revenue,
        expenses: fin?.expenses,
        assets: fin?.assets,
        liabilities: fin?.liabilities,
        donors,
        trend,
        program_ratio: Number(programRatio.toFixed(2))
      }
    };
  });
}
//Detect “amount-only follow-up”
function isAmountOnlyUpdate(messages) {
  const text = messages.filter(m => m.role === "user").at(-1)?.content.toLowerCase() || "";
  return (
    (text.includes("increase") || text.includes("update") || text.includes("change")) &&
    /\d+/.test(text) &&
    !text.includes("charity") &&
    !text.includes("cause") &&
    !text.includes("region")
  );
}
//Detect if the user explicitly asked for a charity name
function userExplicitlyNamedCharity(messages) {
  const text = messages.filter(m => m.role === "user").at(-1)?.content?.toLowerCase() || "";
  return (
    text.includes("charity") ||
    text.includes("foundation") ||
    text.includes("trust") ||
    text.includes("donate to") ||
    text.includes("allocate to")
  );
}


// ================================
// WORKER HANDLER
// ================================
export default {
  async fetch(request, env) {

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    if (request.method !== "POST") {
      return new Response("Worker online", { headers: corsHeaders });
    }

    // Rate limit
    const ip = request.headers.get("CF-Connecting-IP") || "anon";
    const now = Date.now();
    const entry = ipStore.get(ip) || { count: 0, start: now };

    if (now - entry.start > WINDOW_MS) {
      entry.count = 0;
      entry.start = now;
    }

    entry.count++;
    ipStore.set(ip, entry);

    if (entry.count > RATE_LIMIT) {
      return new Response(JSON.stringify({ error: "Rate limit exceeded" }), { headers: corsHeaders });
    }

    try {
      const body = await request.json();

      // 🚨 Guardrail: reject unrelated queries
      if (!isAllocationIntent(body.messages)) {
        return new Response(JSON.stringify({
          choices: [{
            message: {
              content: "I can help with donation allocations. Please provide an amount, causes, or charity names."
            }
          }]
        }), { headers: corsHeaders });
        
      }
      

      // Load dataset once
      if (!cachedData) {
        const [charities, transactions, trends, users, financials] = await Promise.all([
          env.DATASETS.get("charities", { type: "json" }),
          env.DATASETS.get("transactions", { type: "json" }),
          env.DATASETS.get("trends", { type: "json" }),
          env.DATASETS.get("users", { type: "json" }),
          env.DATASETS.get("financials", { type: "json" })
        ]);

        cachedData = { charities, transactions, trends, users, financials };
      }

      const { charities, transactions, trends, users, financials } = cachedData;

      const userId = body.user_id || "user1";
      const userProfile = users.find(u => u.user_id === userId);

      if (!userProfile) {
        return new Response(JSON.stringify({
          choices: [{ message: { content: "User not found in dataset." } }]
        }), { headers: corsHeaders });
      }

      const signals = extractSignals(body.messages, userProfile);

      const explicit = extractRequestedCharities(body.messages, charities);

      // Determine which region was actually used
      let regionUsed;

      if (signals.matchedRegions.length > 0) {
        regionUsed = signals.matchedRegions.join(", ");
      } else if (explicit.length === 0 && userProfile?.default_regions?.length > 0) {
        regionUsed = userProfile.default_regions.join(", ");
      } else {
        regionUsed = "across all regions";
      }   

      let candidates;

      // 1️⃣ Explicit charities (happy path)
      if (explicit.length > 0) {
        candidates = explicit;
      }

      // 2️⃣ Explicit charity mentioned but NOT found → UC5c
      else if (userExplicitlyNamedCharity(body.messages)) {
        return new Response(
          JSON.stringify({
            choices: [{
              message: {
                content: "No matching charities found in the dataset."
              }
            }]
          }),
          { headers: corsHeaders }
        );
      }

      // 3️⃣ Amount-only follow-up (conversation continuity)
      else if (isAmountOnlyUpdate(body.messages)) {
        const prev = lastAllocationContext.get(userId);

        if (!prev) {
          return new Response(
            JSON.stringify({
              choices: [{
                message: {
                  content: "No previous allocation found to update."
                }
              }]
            }),
            { headers: corsHeaders }
          );
        }

        candidates = charities.filter(c =>
          prev.charityIds.includes(c.id)
        );
      }

      // 4️⃣ Default behavior (signals + user defaults)
      else {
        candidates = retrieveRelevantCharities(signals, charities);
      }


      const ranked = candidates
      .map(c => ({ ...c, final_score: scoreCharity(c, trends, transactions, financials) }))
      .sort((a, b) => b.final_score - a.final_score);

    const finalSelection = explicit.length > 0
      ? ranked
      : ranked.slice(0, 5);

      const amount = extractAmount(body.messages) || 500;

      if (amount < 5) {
        return new Response(JSON.stringify({
          choices: [{
            message: {
              content: "Minimum allocation amount is $5. Please enter an amount of $5 or more."
            }
          }]
        }), { headers: corsHeaders });
      }

      // const allocated = explicit.length > 0
      //       ? allocateEvenly(amount, finalSelection, trends, transactions, financials)
      //       : allocateBudget(amount, finalSelection, trends, transactions, financials);
      const allocated = allocateEvenly(amount, finalSelection, trends, transactions, financials);
      lastAllocationContext.set(userId, {
        charityIds: allocated.map(a => a.id),
        mode: explicit.length > 0 ? "explicit" : "derived"
      });
      

      // AUDIT MODE 
      if (isAuditRequest(body.messages)) {
        return new Response(JSON.stringify({
          choices: [{ message: { content: "AUDIT MODE:\n\n" + JSON.stringify(allocated, null, 2) } }]
        }), { headers: corsHeaders });
      }
      const table = [
        "| Charity | Amount | Reason | Causes | Popularity Score | Link |",
        "|--------|--------|--------|--------|------------------|------|",
        ...allocated.map(c =>
          `| ${c.name} | $${c.allocated_amount} | ${c.reason} | ${c.causes_display} | ${c.popularity_score} | ${c.link} |`
        )
      ].join("\n");
      
      
      // Grounded prompt for OpenAI
      const groundedContext = `
            You are given an allocation table below.

            Your job is to write a short narrative strictly based on it.

            Allocation Table:
            ${table}

            You MUST output exactly this structure:

            ### Diversification Rationale
            Write 1–2 sentences describing diversity of causes only.

            ### Portfolio Summary
            Start this sentence exactly with:
            "${userProfile.name}, this portfolio allocates"
            and mention this region explicitly:
            "${regionUsed}"

            ### Conclusion
            Write one short grounded sentence.

            Rules:
            - Do not include numbers not already present.
            - Do not add new facts.
            - Do not repeat the table.
            - Do not leave any section empty.
            - Always output all three sections.
            `;







      // OpenAI call (THIS WAS MISSING BEFORE)
      const openaiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${env.OPENAI_API_KEY}`
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          temperature: 0,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "system", content: groundedContext }
            //...body.messages
          ]
        })
      });

      const data = await openaiResponse.json();

// Combine your deterministic table + model narrative
      const finalText = `
      ### Allocation Table
      ${table}

      ${data.choices?.[0]?.message?.content || ""}
      `;

      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: finalText
          }
        }]
      }), { headers: corsHeaders });


    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { headers: corsHeaders });
    }
  }
};
