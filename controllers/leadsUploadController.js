const { Op, fn, col, where } = require("sequelize");
const validator = require("validator");
const { Lead, LeadStatus, LeadSource, LeadAssignment, LeadNote } = require("../models");

const sanitizeStr = (v) =>
  v === undefined || v === null
    ? ""
    : String(v)
        .replace(/\u00A0/g, " ")
        .trim();

const toSnakeValue = (label) => {
  if (!label) return null;
  return String(label)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
};

const normalizePhoneDigits = (p) => (p ? String(p) : "").replace(/\D+/g, "").slice(0, 32);

const importLeads = async (req, res) => {
  let t;
  try {
    const { leads, fallback_source, is_new_source } = req.body;
    if (!Array.isArray(leads) || leads.length === 0) {
      return res.status(400).json({ success: false, error: "No leads provided." });
    }

    const sequelizeInstance = Lead.sequelize;
    t = await sequelizeInstance.transaction();

    const incomingSourceLabels = new Set();
    for (const r of leads) {
      const src = sanitizeStr(r?.source);
      if (src) incomingSourceLabels.add(src);
    }

    if (fallback_source) {
      incomingSourceLabels.add(sanitizeStr(fallback_source));
    }

    if (incomingSourceLabels.size) {
      const candidateRows = Array.from(incomingSourceLabels)
        .map((label) => ({
          value: toSnakeValue(label),
          label: String(label).trim().slice(0, 80),
        }))
        .filter((r) => r.value && r.label);

      const seenVals = new Set();
      const uniqueRows = [];
      for (const r of candidateRows) {
        if (!seenVals.has(r.value)) {
          seenVals.add(r.value);
          uniqueRows.push(r);
        }
      }

      if (uniqueRows.length) {
        await LeadSource.bulkCreate(uniqueRows, {
          ignoreDuplicates: true,
          transaction: t,
        });
      }
    }

    const [statuses, sources] = await Promise.all([
      LeadStatus.findAll({ transaction: t }),
      LeadSource.findAll({ transaction: t }),
    ]);

    const statusMap = new Map();
    for (const s of statuses) {
      if (s.label) statusMap.set(sanitizeStr(s.label).toLowerCase(), s);
      if (s.value) statusMap.set(sanitizeStr(s.value).toLowerCase(), s);
    }
    const defaultStatus = statusMap.get("new") || null;

    const sourceMap = new Map();
    for (const s of sources) {
      if (s.label) sourceMap.set(sanitizeStr(s.label).toLowerCase(), s);
      if (s.value) sourceMap.set(sanitizeStr(s.value).toLowerCase(), s);
    }
    let defaultSource = null;

    if (fallback_source) {
      const key = sanitizeStr(fallback_source).toLowerCase();
      defaultSource = sourceMap.get(key) || null;
    }

    const prepared = [];
    const notes = [];
    const seenEmails = new Set();
    const seenPhones = new Set();

    leads.forEach((row, idx) => {
      const r = row || {};

      let email = sanitizeStr(r.email).toLowerCase();
      if (email === "") email = null;

      const phoneRaw = sanitizeStr(r.phone) || null;
      const phoneNorm = phoneRaw ? normalizePhoneDigits(phoneRaw) : null;

      if (email && !validator.isEmail(email)) {
        notes.push({ index: idx, email, note: "invalid_email_format" });
        return;
      }

      if (email && seenEmails.has(email)) {
        notes.push({ index: idx, email, note: "duplicate_email_in_file" });
        return;
      }
      if (email) seenEmails.add(email);

      if (phoneNorm && seenPhones.has(phoneNorm)) {
        notes.push({ index: idx, phone: phoneRaw, note: "duplicate_phone_in_file" });
        return;
      }
      if (phoneNorm) seenPhones.add(phoneNorm);

      let st = null;
      const rStatus = sanitizeStr(r.status).toLowerCase();
      if (rStatus) st = statusMap.get(rStatus);
      if (!st) st = defaultStatus;

      let src = null;
      const rSource = sanitizeStr(r.source).toLowerCase();

      if (rSource) {
        src = sourceMap.get(rSource);
      }

      if (!src && defaultSource) {
        src = defaultSource;
      }

      const noteBody = sanitizeStr(r.notes);

      prepared.push({
        _rowIndex: idx,
        first_name: sanitizeStr(r.first_name) || null,
        last_name: sanitizeStr(r.last_name) || null,
        company: sanitizeStr(r.company) || null,
        email,
        phone: phoneRaw,
        _phoneNorm: phoneNorm,
        country: sanitizeStr(r.country) || null,
        language: sanitizeStr(r.language) || null,
        status_id: st ? st.id : null,
        source_id: src ? src.id : null,
        _noteBody: noteBody,
        created_by: req.user?.id || null,
        updated_by: req.user?.id || null,
      });
    });

    if (prepared.length === 0) {
      await t.rollback();
      return res.status(400).json({
        success: false,
        error: "No valid rows to import.",
        details: { notes },
      });
    }

    const emails = prepared.map((p) => p.email).filter(Boolean);
    const phoneNorms = Array.from(new Set(prepared.map((p) => p._phoneNorm).filter(Boolean)));

    const whereClauses = [];
    if (emails.length) {
      whereClauses.push({ email: { [Op.in]: emails } });
    }
    if (phoneNorms.length) {
      const normalizedDbPhone = fn("REGEXP_REPLACE", col("phone"), "[^0-9]", "");
      whereClauses.push(where(normalizedDbPhone, { [Op.in]: phoneNorms }));
    }

    const existing = whereClauses.length
      ? await Lead.findAll({
          where: { [Op.or]: whereClauses },
          attributes: ["email", "phone"],
          transaction: t,
        })
      : [];

    const existingEmails = new Set(
      existing
        .map((e) => e.email)
        .filter(Boolean)
        .map((e) => String(e).toLowerCase()),
    );

    const existingPhoneNorms = new Set(existing.map((e) => normalizePhoneDigits(e.phone)).filter(Boolean));

    const toInsert = [];
    for (const p of prepared) {
      if (p.email && existingEmails.has(p.email)) {
        notes.push({ index: p._rowIndex, email: p.email, note: "duplicate_email_in_db" });
        continue;
      }
      if (p._phoneNorm && existingPhoneNorms.has(p._phoneNorm)) {
        notes.push({ index: p._rowIndex, phone: p.phone, note: "duplicate_phone_in_db" });
        continue;
      }
      toInsert.push(p);
    }

    if (toInsert.length === 0) {
      await t.rollback();
      return res.status(409).json({
        success: false,
        error: "All rows are duplicates or invalid (by email/phone).",
        details: { notes },
      });
    }

    const createdLeads = await Lead.bulkCreate(
      toInsert.map(({ _rowIndex, _phoneNorm, _noteBody, ...rest }) => rest),
      { validate: true, returning: true, transaction: t },
    );

    if (req.user?.id && createdLeads.length) {
      const assignments = createdLeads.map((l) => ({
        lead_id: l.id,
        assignee_id: req.user.id,
        assigned_by: req.user.id,
      }));
      await LeadAssignment.bulkCreate(assignments, { transaction: t });
    }

    const notesPayload = [];
    for (let i = 0; i < createdLeads.length; i++) {
      const noteBody = toInsert[i]._noteBody;
      if (typeof noteBody === "string" && noteBody.trim().length > 0) {
        notesPayload.push({
          lead_id: createdLeads[i].id,
          author_id: req.user?.id || null,
          body: noteBody.trim(),
        });
      }
    }

    if (notesPayload.length) {
      await LeadNote.bulkCreate(notesPayload, { transaction: t });
    }

    await t.commit();

    return res.status(201).json({
      success: true,
      message: `${createdLeads.length} leads imported successfully.`,
      summary: {
        attempted: leads.length,
        inserted: createdLeads.length,
        duplicates_or_skipped: notes.length,
      },
      notes,
      data: createdLeads,
    });
  } catch (err) {
    console.error("Import Error:", err);
    if (t) {
      try {
        await t.rollback();
      } catch (_) {}
    }
    return res.status(500).json({ success: false, error: "Error importing leads." });
  }
};

const getTemplateSchema = async (req, res) => {
  try {
    return res.json({
      fields: [
        "first_name",
        "last_name",
        "company",
        "email",
        "phone",
        "country",
        "language",
        "status",
        "source",
        "notes",
      ],
      defaults: {
        status: "New",
        source: "Choose Fallback Source",
      },
      duplicate_check: "email_or_phone (phone compared by digits-only)",
      notes: [
        "If status is missing or invalid, 'new' is used.",
        "If source is missing or invalid, 'facebook' is used.",
        "Unknown sources are created automatically (value = lowercase_with_underscores, label = original).",
        "Duplicates are detected by email OR phone; phone is normalized to digits-only for comparison.",
        "Rows with invalid email format are skipped.",
        "If a row includes 'notes', it is saved as the first note on that lead.",
      ],
    });
  } catch (err) {
    console.error("Schema Error:", err);
    return res.status(500).json({ success: false, error: "Could not fetch template schema." });
  }
};

module.exports = { importLeads, getTemplateSchema };
