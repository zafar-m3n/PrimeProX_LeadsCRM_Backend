const { DataTypes } = require("sequelize");
const { sequelize } = require("../config/database");

const Lead = sequelize.define(
  "Lead",
  {
    id: {
      type: DataTypes.BIGINT,
      autoIncrement: true,
      primaryKey: true,
    },
    first_name: {
      type: DataTypes.STRING(100),
      allowNull: true,
    },
    last_name: {
      type: DataTypes.STRING(100),
      allowNull: true,
    },
    company: {
      type: DataTypes.STRING(160),
      allowNull: true,
    },
    email: {
      type: DataTypes.STRING(160),
      allowNull: true,
      validate: { isEmail: true },
    },
    phone: {
      type: DataTypes.STRING(40),
      allowNull: true,
    },
    country: {
      type: DataTypes.STRING(80),
      allowNull: true,
    },
    language: {
      type: DataTypes.ENUM("English", "Hindi", "Tamil"),
      allowNull: true,
    },
    status_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: "lead_statuses", key: "id" },
    },
    source_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: "lead_sources", key: "id" },
    },
    created_by: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: "users", key: "id" },
    },
    updated_by: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: "users", key: "id" },
    },
    created_at: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
    updated_at: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
  },
  {
    tableName: "leads",
    timestamps: false,
    underscored: true,
  },
);

module.exports = Lead;
