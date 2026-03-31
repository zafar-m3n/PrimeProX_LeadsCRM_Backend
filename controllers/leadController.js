const { Op, literal } = require("sequelize");
const { Lead, LeadStatus, LeadSource, User, LeadAssignment, LeadNote } = require("../models");
const { sequelize } = require("../config/database");
const { resSuccess, resError } = require("../utils/responseUtil");

const ROLE_IDS = {
  admin: 1,
  manager: 2,
  sales_rep: 3,
};

const UNASSIGNED_ROLE_IDS = [ROLE_IDS.admin, ROLE_IDS.manager];
const ASSIGNED_ROLE_IDS = [ROLE_IDS.sales_rep];

const LATEST_ASSIGNMENT_IDS = literal(`(SELECT MAX(id) FROM lead_assignments GROUP BY lead_id)`);

const buildLatestAssignmentInclude = (
  assigneeIds = [],
  assignedFrom = null,
  assignedTo = null,
  forceRequired = false,
  assignmentState = null,
) => {
  const where = { id: { [Op.in]: LATEST_ASSIGNMENT_IDS } };

  if (Array.isArray(assigneeIds) && assigneeIds.length > 0) {
    where.assignee_id = { [Op.in]: assigneeIds.map(Number).filter(Boolean) };
  }

  if (assignedFrom || assignedTo) {
    where.assigned_at = {};
    if (assignedFrom) where.assigned_at[Op.gte] = assignedFrom;
    if (assignedTo) where.assigned_at[Op.lte] = assignedTo;
  }

  const assigneeWhere = {};

  if (assignmentState === "assigned") {
    assigneeWhere.role_id = { [Op.in]: ASSIGNED_ROLE_IDS };
  }

  if (assignmentState === "unassigned") {
    assigneeWhere.role_id = { [Op.in]: UNASSIGNED_ROLE_IDS };
  }

  return {
    model: LeadAssignment,
    as: "LeadAssignments",
    required:
      forceRequired ||
      (Array.isArray(assigneeIds) && assigneeIds.length > 0) ||
      !!(assignedFrom || assignedTo) ||
      !!assignmentState,
    where,
    include: [
      {
        model: User,
        as: "assignee",
        attributes: ["id", "full_name", "email", "role_id"],
        required: !!assignmentState,
        ...(Object.keys(assigneeWhere).length ? { where: assigneeWhere } : {}),
      },
    ],
  };
};

const createLead = async (req, res) => {
  const t = await sequelize.transaction();
  try {
    const { first_name, last_name, company, email, phone, country, language, status_id, source_id, notes } = req.body;

    if (!status_id) {
      await t.rollback();
      return resError(res, "status_id is required", 400);
    }

    const lead = await Lead.create(
      {
        first_name,
        last_name,
        company,
        email,
        phone,
        country,
        language,
        status_id,
        source_id,
        created_by: req.user.id,
      },
      { transaction: t },
    );

    await LeadAssignment.create(
      {
        lead_id: lead.id,
        assignee_id: req.user.id,
        assigned_by: req.user.id,
      },
      { transaction: t },
    );

    if (typeof notes === "string" && notes.trim().length > 0) {
      const note = await LeadNote.create(
        {
          lead_id: lead.id,
          author_id: req.user.id,
          body: notes.trim(),
        },
        { transaction: t },
      );

      await lead.update({ updated_at: note.created_at }, { transaction: t });
    }

    await t.commit();
    return resSuccess(res, lead, 201);
  } catch (err) {
    console.error("CreateLead Error:", err);
    try {
      await t.rollback();
    } catch (_) {}
    return resError(res, "Internal server error", 500);
  }
};

const getLeads = async (req, res) => {
  try {
    const { role, id: userId } = req.user;
    const {
      status_ids,
      source_ids,
      assignee_ids,
      assignment_state,
      orderBy,
      orderDir,
      search,
      languages,
      page = 1,
      limit = 10,
      assigned_from,
      assigned_to,
    } = req.query;

    const where = {};

    if (status_ids) {
      const ids = status_ids
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map(Number)
        .filter(Boolean);

      if (ids.length > 0) {
        where.status_id = { [Op.in]: ids };
      }
    }

    if (source_ids) {
      const ids = source_ids
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map(Number)
        .filter(Boolean);

      if (ids.length > 0) {
        where.source_id = { [Op.in]: ids };
      }
    }

    if (search) {
      const digitsOnly = String(search).replace(/\D+/g, "");
      const orClauses = [
        { first_name: { [Op.like]: `%${search}%` } },
        { last_name: { [Op.like]: `%${search}%` } },
        { email: { [Op.like]: `%${search}%` } },
        { phone: { [Op.like]: `%${search}%` } },
      ];

      if (digitsOnly.length >= 3 && digitsOnly.length <= 5) {
        orClauses.push({ phone: { [Op.like]: `%${digitsOnly}` } });
      }

      where[Op.or] = orClauses;
    }

    let assignedFrom = null;
    let assignedTo = null;

    if (assigned_from) {
      const d = new Date(assigned_from);
      if (!isNaN(d)) {
        assignedFrom = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0));
      }
    }

    if (assigned_to) {
      const d = new Date(assigned_to);
      if (!isNaN(d)) {
        assignedTo = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59, 999));
      }
    }

    const parsedAssigneeIds = assignee_ids
      ? assignee_ids
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
          .map(Number)
          .filter(Boolean)
      : [];

    const normalizedAssignmentState =
      assignment_state === "assigned" || assignment_state === "unassigned" ? assignment_state : null;

    let order = [["id", "ASC"]];
    if (orderBy) {
      const dir = (orderDir || "ASC").toUpperCase() === "DESC" ? "DESC" : "ASC";

      if (orderBy === "assigned_at") {
        order = [[{ model: LeadAssignment, as: "LeadAssignments" }, "assigned_at", dir]];
      } else {
        order = [[orderBy, dir]];
      }
    }

    if (languages) {
      const langs = languages
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

      if (langs.length > 0) {
        where.language = { [Op.in]: langs };
      }
    }

    const pageNum = parseInt(page, 10);
    const pageLimit = parseInt(limit, 10);
    const offset = (pageNum - 1) * pageLimit;

    const needDateFilter = !!(assignedFrom || assignedTo);

    const latestInclude =
      role === "sales_rep"
        ? buildLatestAssignmentInclude([userId], assignedFrom, assignedTo, true, "assigned")
        : buildLatestAssignmentInclude(
            normalizedAssignmentState === "unassigned" ? [] : parsedAssigneeIds,
            assignedFrom,
            assignedTo,
            needDateFilter || parsedAssigneeIds.length > 0 || !!normalizedAssignmentState,
            normalizedAssignmentState,
          );

    const { count, rows: leads } = await Lead.findAndCountAll({
      where,
      include: [
        { model: LeadStatus, attributes: ["id", "value", "label"] },
        { model: LeadSource, attributes: ["id", "value", "label"] },
        { model: User, as: "creator", attributes: ["id", "full_name", "email"] },
        { model: User, as: "updater", attributes: ["id", "full_name", "email"] },
        latestInclude,
      ],
      distinct: true,
      col: "id",
      order,
      limit: pageLimit,
      offset,
    });

    return resSuccess(res, {
      leads,
      pagination: {
        total: count,
        page: pageNum,
        limit: pageLimit,
        totalPages: Math.ceil(count / pageLimit),
      },
    });
  } catch (err) {
    console.error("GetLeads Error:", err);
    return resError(res, "Internal server error", 500);
  }
};

const getLeadById = async (req, res) => {
  try {
    const { id } = req.params;

    const lead = await Lead.findByPk(id, {
      include: [
        { model: LeadStatus, attributes: ["id", "value", "label"] },
        { model: LeadSource, attributes: ["id", "value", "label"] },
        { model: User, as: "creator", attributes: ["id", "full_name", "email"] },
        { model: User, as: "updater", attributes: ["id", "full_name", "email"] },
        {
          model: LeadAssignment,
          as: "LeadAssignments",
          required: false,
          where: { id: { [Op.in]: LATEST_ASSIGNMENT_IDS } },
          include: [{ model: User, as: "assignee", attributes: ["id", "full_name", "email"] }],
        },
        {
          model: LeadNote,
          as: "notes",
          required: false,
          separate: true,
          include: [{ model: User, as: "author", attributes: ["id", "full_name", "email"] }],
          order: [["created_at", "DESC"]],
        },
      ],
    });

    if (!lead) return resError(res, "Lead not found", 404);
    return resSuccess(res, lead);
  } catch (err) {
    console.error("GetLeadById Error:", err);
    return resError(res, "Internal server error", 500);
  }
};

const updateLead = async (req, res) => {
  const t = await sequelize.transaction();
  try {
    const { id } = req.params;

    const lead = await Lead.findByPk(id, { transaction: t });
    if (!lead) {
      await t.rollback();
      return resError(res, "Lead not found", 404);
    }

    if (req.user.role === "sales_rep") {
      const latest = await LeadAssignment.findOne({
        where: { lead_id: id },
        order: [["id", "DESC"]],
        attributes: ["assignee_id"],
        transaction: t,
      });

      const currentAssigneeId = latest?.assignee_id ?? null;

      if (currentAssigneeId !== req.user.id) {
        await t.rollback();
        return resError(res, "Sales rep can only update leads assigned to them", 403);
      }
    }

    const { first_name, last_name, company, email, phone, country, language, status_id, source_id, notes } = req.body;

    if (first_name !== undefined) lead.first_name = first_name;
    if (last_name !== undefined) lead.last_name = last_name;
    if (company !== undefined) lead.company = company;
    if (email !== undefined) lead.email = email;
    if (phone !== undefined) lead.phone = phone;
    if (country !== undefined) lead.country = country;
    if (language !== undefined) lead.language = language;
    if (status_id !== undefined) lead.status_id = status_id;
    if (source_id !== undefined) lead.source_id = source_id;

    lead.updated_by = req.user.id;
    await lead.save({ transaction: t });

    if (typeof notes === "string" && notes.trim().length > 0) {
      const note = await LeadNote.create(
        {
          lead_id: lead.id,
          author_id: req.user.id,
          body: notes.trim(),
        },
        { transaction: t },
      );

      await lead.update({ updated_at: note.created_at }, { transaction: t });
    }

    await t.commit();
    return resSuccess(res, lead);
  } catch (err) {
    console.error("UpdateLead Error:", err);
    try {
      await t.rollback();
    } catch (_) {}
    return resError(res, "Internal server error", 500);
  }
};

const deleteLead = async (req, res) => {
  try {
    const { id } = req.params;

    const lead = await Lead.findByPk(id);
    if (!lead) return resError(res, "Lead not found", 404);

    await lead.destroy();
    return resSuccess(res, { message: "Lead deleted successfully" });
  } catch (err) {
    console.error("DeleteLead Error:", err);
    return resError(res, "Internal server error", 500);
  }
};

const assignLead = async (req, res) => {
  try {
    const { id } = req.params;
    const { assignee_id } = req.body;

    const lead = await Lead.findByPk(id);
    if (!lead) return resError(res, "Lead not found", 404);

    const user = await User.findByPk(assignee_id);
    if (!user) return resError(res, "Assignee not found", 404);

    const assignment = await LeadAssignment.create({
      lead_id: id,
      assignee_id,
      assigned_by: req.user.id,
    });

    return resSuccess(res, assignment, 201);
  } catch (err) {
    console.error("AssignLead Error:", err);
    return resError(res, "Internal server error", 500);
  }
};

const getLeadAssignments = async (req, res) => {
  try {
    const { id } = req.params;

    const lead = await Lead.findByPk(id);
    if (!lead) return resError(res, "Lead not found", 404);

    const assignments = await LeadAssignment.findAll({
      where: { lead_id: id },
      include: [
        { model: User, as: "assignee", attributes: ["id", "full_name", "email"] },
        { model: User, as: "assigner", attributes: ["id", "full_name", "email"] },
      ],
      order: [["assigned_at", "DESC"]],
    });

    return resSuccess(res, assignments);
  } catch (err) {
    console.error("GetLeadAssignments Error:", err);
    return resError(res, "Internal server error", 500);
  }
};

const deleteLeadNote = async (req, res) => {
  try {
    const { leadId, noteId } = req.params;
    const { role } = req.user;

    if (role !== "admin" && role !== "manager") {
      return resError(res, "You are not authorized to delete notes.", 403);
    }

    const note = await LeadNote.findOne({
      where: { id: noteId, lead_id: leadId },
    });

    if (!note) {
      return resError(res, "Note not found.", 404);
    }

    await note.destroy();
    return resSuccess(res, { message: "Note deleted successfully." });
  } catch (err) {
    console.error("DeleteLeadNote Error:", err);
    return resError(res, "Internal server error", 500);
  }
};

module.exports = {
  createLead,
  getLeads,
  getLeadById,
  updateLead,
  deleteLead,
  assignLead,
  getLeadAssignments,
  deleteLeadNote,
};
