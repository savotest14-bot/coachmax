const BankDetails = require("../models/BankDetails");
const fs = require("fs");
const path = require("path");

exports.upsertBankDetails = async (req, res) => {
  try {
    const {
      accountName,
      bankName,
      accountNumber,
      iban,
      swiftCode,
      branch,
      instructions,
    } = req.body;

    if (!accountName || !bankName || !accountNumber) {
      return res.status(400).json({
        success: false,
        message:
          "accountName, bankName, and accountNumber are required",
      });
    }

    let bankDetails = await BankDetails.findOne();
    const isCreate = !bankDetails;

    if (!bankDetails) {
      bankDetails = new BankDetails();
    }

    bankDetails.accountName = accountName;
    bankDetails.bankName = bankName;
    bankDetails.accountNumber = accountNumber;
    bankDetails.iban = iban || "";
    bankDetails.swiftCode = swiftCode || "";
    bankDetails.branch = branch || "";
    bankDetails.instructions = instructions || "";

    if (req.file) {
      if (bankDetails.qrCodeImage) {
        try {
          const oldImagePath = path.join(
            process.cwd(),
            bankDetails.qrCodeImage
          );

          if (fs.existsSync(oldImagePath)) {
            fs.unlinkSync(oldImagePath);
          }
        } catch (error) {
          console.error(
            "Error deleting old QR code image:",
            error.message
          );
        }
      }

      bankDetails.qrCodeImage = `uploads/bank-details/${req.file.filename}`;
    }

    if (req.admin) {
      bankDetails.updatedBy = req.admin._id;
    }

    await bankDetails.save();

    return res.status(isCreate ? 201 : 200).json({
      success: true,
      message: isCreate
        ? "Bank details created successfully"
        : "Bank details updated successfully",
      data: bankDetails,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

exports.getBankDetails = async (req, res) => {
  try {
    const activeDetails = await BankDetails.findOne({ isActive: true }).sort({ updatedAt: -1 });

    if (!activeDetails) {
      const anyDetails = await BankDetails.findOne().sort({ updatedAt: -1 });
      return res.status(200).json({
        success: true,
        data: anyDetails || null,
      });
    }

    return res.status(200).json({
      success: true,
      data: activeDetails,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

exports.getAllBankDetails = async (req, res) => {
  try {
    const list = await BankDetails.find().sort({ createdAt: -1 });
    return res.status(200).json({
      success: true,
      count: list.length,
      data: list,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};
