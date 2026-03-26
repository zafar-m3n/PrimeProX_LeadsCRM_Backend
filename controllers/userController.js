const bcrypt = require("bcrypt");
const { User, Role } = require("../models");
const { resSuccess, resError } = require("../utils/responseUtil");

const BCRYPT_ROUNDS = parseInt(process.env.NODE_LEADHIVE_BCRYPT_SALT_ROUNDS || "10", 10);

const sanitizeUser = (user) => {
  const plain = user.toJSON();
  delete plain.password_hash;
  return plain;
};

const createUser = async (req, res) => {
  try {
    const { full_name, email, password, role_id } = req.body;

    if (!full_name || !email || !password || !role_id) {
      return resError(res, "Missing required fields", 400);
    }

    const existing = await User.findOne({ where: { email } });
    if (existing) return resError(res, "Email already in use", 400);

    const role = await Role.findByPk(role_id);
    if (!role) return resError(res, "Invalid role_id", 400);

    const password_hash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    const user = await User.create({
      full_name,
      email,
      password_hash,
      role_id,
      is_active: true,
    });

    const created = await User.findByPk(user.id, {
      include: [{ model: Role, attributes: ["id", "value", "label"] }],
    });

    return resSuccess(res, sanitizeUser(created), 201);
  } catch (err) {
    console.error("CreateUser Error:", err);
    return resError(res, "Internal server error", 500);
  }
};

const getUsers = async (req, res) => {
  try {
    let { page = 1, limit = 10 } = req.query;

    page = parseInt(page, 10);
    limit = parseInt(limit, 10);

    if (isNaN(page) || page < 1) page = 1;
    if (isNaN(limit) || limit < 1) limit = 10;

    const offset = (page - 1) * limit;

    const { rows, count } = await User.findAndCountAll({
      where: {
        is_active: true,
        id: {
          [require("sequelize").Op.ne]: 1,
        },
      },
      include: [{ model: Role, attributes: ["id", "value", "label"] }],
      order: [["id", "ASC"]],
      offset,
      limit,
    });

    const safe = rows.map(sanitizeUser);

    return resSuccess(res, {
      users: safe,
      pagination: {
        total: count,
        page,
        limit,
        totalPages: Math.ceil(count / limit),
      },
    });
  } catch (err) {
    console.error("GetUsers Error:", err);
    return resError(res, "Internal server error", 500);
  }
};

const getUserById = async (req, res) => {
  try {
    const { id } = req.params;

    if (parseInt(id, 10) === 1) {
      return resError(res, "User not found", 404);
    }

    const user = await User.findByPk(id, {
      include: [{ model: Role, attributes: ["id", "value", "label"] }],
    });

    if (!user) return resError(res, "User not found", 404);

    return resSuccess(res, sanitizeUser(user));
  } catch (err) {
    console.error("GetUserById Error:", err);
    return resError(res, "Internal server error", 500);
  }
};

const updateUser = async (req, res) => {
  try {
    const { id } = req.params;
    const { full_name, email, password, role_id, is_active } = req.body;

    const user = await User.findByPk(id);
    if (!user) return resError(res, "User not found", 404);

    if (full_name !== undefined) {
      user.full_name = full_name;
    }

    if (email !== undefined) {
      const existing = await User.findOne({
        where: { email },
      });

      if (existing && existing.id !== user.id) {
        return resError(res, "Email already in use", 400);
      }

      user.email = email;
    }

    if (role_id !== undefined) {
      const role = await Role.findByPk(role_id);
      if (!role) return resError(res, "Invalid role_id", 400);

      user.role_id = role_id;
    }

    if (password !== undefined && password !== "") {
      user.password_hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    }

    if (is_active !== undefined) {
      user.is_active = is_active;
    }

    await user.save();

    const updated = await User.findByPk(id, {
      include: [{ model: Role, attributes: ["id", "value", "label"] }],
    });

    return resSuccess(res, sanitizeUser(updated));
  } catch (err) {
    console.error("UpdateUser Error:", err);
    return resError(res, "Internal server error", 500);
  }
};

const deleteUser = async (req, res) => {
  try {
    const { id } = req.params;

    const user = await User.findByPk(id);
    if (!user) return resError(res, "User not found", 404);

    user.is_active = false;
    await user.save();

    return resSuccess(res, { message: "User deactivated successfully" });
  } catch (err) {
    console.error("DeleteUser Error:", err);
    return resError(res, "Internal server error", 500);
  }
};

module.exports = {
  createUser,
  getUsers,
  getUserById,
  updateUser,
  deleteUser,
};
