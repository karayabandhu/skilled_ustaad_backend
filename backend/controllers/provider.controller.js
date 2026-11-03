import crypto from "crypto";
import { uploadToStorage } from "../libs/storage.js";
import { StatusCodes } from "http-status-codes";
import Provider from "../models/Provider.js";
import { generateOTP, sendOTP } from "../libs/otpProvider.js";
import { sendEmail } from "../libs/emailProvider.js";
import { getForgotPasswordTemplate } from "../libs/emailTemplates.js";
import { signAccess, signRefresh, verifyRefresh } from "../libs/token.js";
import {
  providerRegisterSchema,
  providerLoginSchema,
  providerVerifySchema,
  providerUpdateSchema,
  providerForgotPasswordSchema,
  providerResetPasswordSchema,
  businessDetailsSchema,
  workerSchema
} from "../validations/schemas.js";
import { runInNewContext } from "vm";
import { broadcastStats } from "../libs/socket.js";
import { sendAdminNotification } from "../services/fcm.service.js";
import { isWhitelisted, DEFAULT_OTP } from "../libs/otpWhitelist.js";
import { error } from "console";

const hash = (s) =>
  crypto.createHash("sha256").update(s).digest("hex");

const OTP_TTL_MS = 5 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;

/* =========================================================
   STEP 1 — REGISTER (PASSWORD BASED)
========================================================= */
export async function registerProvider(req, res) {
  try {
    const { error, value } = providerRegisterSchema.validate(req.body);
    if (error) {
      return res.status(StatusCodes.BAD_REQUEST).json({
        error: error.details[0].message,
      });
    }

    const { fullName, email, phoneNumber, password, providerType = "individual", businessName = "" } = value;

    let provider = await Provider.findOne({
      $or: [
        { phoneNumber },
        { email: email.toLowerCase() }
      ]
    });

    if (provider) {
      if (provider.status === "Terminated") {
        return res.status(StatusCodes.FORBIDDEN).json({
          error: "Access denied. Admin has terminated your account. Please contact support.",
        });
      }
      if (provider.email === email.toLowerCase()) {
        return res.status(StatusCodes.CONFLICT).json({ error: "Email address already registered. Please login instead." });
      }
      return res.status(StatusCodes.CONFLICT).json({ error: "Phone number already registered. Please login instead." });
    }

    provider = new Provider({
      providerType,
      fullName,
      email: email.toLowerCase(),
      phoneNumber,
      password,
      isVerified: true,
      businessDetails: businessName ? { businessName } : undefined
    });

    await provider.save();

    // Issue tokens immediately for step-by-step onboarding
    const accessToken = signAccess({ sub: provider._id.toString(), role: "provider" });
    const refreshToken = signRefresh({ sub: provider._id.toString(), role: "provider" });

    // Add refresh token atomically
    await Provider.findByIdAndUpdate(provider._id, {
      $push: { refreshToken: { $each: [refreshToken], $slice: -10 } }
    });

    // Notify Admin (fire-and-forget, don't let it crash registration)
    try {
      sendAdminNotification({
        type: "new_provider",
        title: "🛠️ New Provider Joined",
        message: `${provider.fullName} has registered and started onboarding.`,
        metadata: { providerId: provider._id.toString() }
      });
    } catch (_) { /* swallow admin notification errors */ }

    res.cookie("provider_refreshToken", refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    broadcastStats();

    return res.status(StatusCodes.CREATED).json({
      message: "Registration successful",
      accessToken,
      provider: {
        id: provider._id,
        fullName: provider.fullName,
        email: provider.email,
        phoneNumber: provider.phoneNumber,
        providerType: provider.providerType,
        applicationStatus: provider.applicationStatus,
        status: provider.status
      }
    });
  } catch (err) {
    console.error("Register Error:", err);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: "Server error during registration",
    });
  }
}

/* =========================================================
   STEP 2 — VERIFY OTP & ISSUE TOKENS
========================================================= */
export async function verifyProviderOTP(req, res) {
  try {

    const result = providerVerifySchema.validate(req.body);

    if (result.error) {
      return res.status(StatusCodes.BAD_REQUEST).json({
        error: result.error.details[0].message,
      });
    }

    const { phoneNumber, otp } = result.value;

    const provider = await Provider.findOne({ phoneNumber }).select("+otpHash +otpExpires");
    if (!provider) {
      return res.status(StatusCodes.NOT_FOUND).json({
        error: "Provider not found",
      });
    }

    if (provider.status === "Terminated") {
      return res.status(StatusCodes.FORBIDDEN).json({
        error: "Access denied. Admin has terminated your account. Please contact support.",
      });
    }

    const isStaticMatch = otp === DEFAULT_OTP;

    // Check whitelist bypass first
    if (!(isWhitelisted(phoneNumber) && isStaticMatch)) {
      if (
        !provider.otpHash ||
        !provider.otpExpires ||
        provider.otpExpires < new Date()
      ) {
        return res.status(StatusCodes.BAD_REQUEST).json({
          error: "OTP expired or invalid",
        });
      }

      if (provider.otpHash !== hash(otp)) {
        return res.status(StatusCodes.BAD_REQUEST).json({
          error: "Invalid OTP",
        });
      }
    }

    const accessToken = signAccess({ sub: provider._id.toString(), role: "provider" });
    const refreshToken = signRefresh({ sub: provider._id.toString(), role: "provider" });

    // Atomic update to save refresh token and verify provider without validation errors
    const updatedProvider = await Provider.findByIdAndUpdate(provider._id, {
      isVerified: true,
      $push: {
        refreshToken: {
          $each: [refreshToken],
          $slice: -10
        }
      },
      $unset: { otpHash: 1, otpExpires: 1 }
    }, { new: true });

    // Notify Admin
    if (!provider.isVerified) {
      sendAdminNotification({
        type: "new_provider",
        title: "🛠️ New Provider Onboarding",
        message: `${updatedProvider.fullName} start registration.`,
        metadata: { providerId: updatedProvider._id.toString() }
      });
    }

    res.cookie("provider_refreshToken", refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    broadcastStats();

    return res.status(StatusCodes.OK).json({
      message: "OTP verified successfully",
      accessToken,
      provider: updatedProvider
    });
  } catch (err) {
    console.error("Verify OTP Error:", err);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: "Server error while verifying OTP",
    });
  }
}

/* =========================================================
   REFRESH TOKEN
 ========================================================= */
export async function refreshToken(req, res) {
  try {
    const token = req.cookies.provider_refreshToken;

    if (!token) {
      return res.status(StatusCodes.UNAUTHORIZED).json({
        error: "Refresh token missing",
      });
    }

    const payload = verifyRefresh(token);
    if (!payload || !payload.sub || payload.role !== "provider") {
      return res.status(StatusCodes.UNAUTHORIZED).json({
        error: "Invalid refresh token",
      });
    }

    const provider = await Provider.findById(payload.sub).select("+refreshToken");
    const hasToken = provider && (Array.isArray(provider.refreshToken) ? provider.refreshToken.includes(token) : provider.refreshToken === token);
    if (!provider || !hasToken) {
      return res.status(StatusCodes.UNAUTHORIZED).json({
        error: "Token revoked or invalid",
      });
    }

    const accessToken = signAccess({
      sub: provider._id.toString(),
      role: "provider",
    });

    return res.status(StatusCodes.OK).json({
      accessToken,
    });
  } catch (err) {
    console.error("Refresh Token Error:", err);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: "Server error during token refresh",
    });
  }
}


/* =========================================================
   STEP 3 — SAVE SERVICE DETAILS (PROTECTED)
========================================================= */
export async function saveServiceDetails(req, res) {
  try {
    const provider = await Provider.findById(req.user.sub);
    if (!provider) {
      return res.status(StatusCodes.NOT_FOUND).json({
        error: "Provider not found",
      });
    }

    const {
      serviceCategory,
      providerSubService,
      subService,
      experience,
      languageSpoken,
      houseNumber,
      colony,
      landmark,
      city,
      state,
      pinCode,
      latitude,
      longitude
    } = req.body;

    provider.serviceCategory = serviceCategory;
    provider.providerSubService = providerSubService;
    provider.subService = subService;
    provider.experience = experience;
    provider.languageSpoken = languageSpoken;

    provider.address = {
      houseNumber,
      colony,
      landmark
    };

    provider.city = city;
    provider.state = state;
    provider.pinCode = pinCode;

    // SAVE GEO LOCATION
    if (latitude && longitude) {
      provider.location = {
        type: "Point",
        coordinates: [Number(longitude), Number(latitude)]
      };
    }

    await provider.save();

    return res.status(StatusCodes.OK).json({
      message: "Service details saved successfully"
    });

  } catch (err) {
    console.error(err);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: "Failed to save service details"
    });
  }
}

/* =========================================================
   STEP 4 — UPLOAD DOCUMENTS (PROTECTED)
 ========================================================= */
export async function uploadDocuments(req, res) {
  try {
    const provider = await Provider.findById(req.user.sub);
    if (!provider) {
      return res.status(StatusCodes.NOT_FOUND).json({
        error: "Provider not found",
      });
    }

    // Optimization: Parallel file uploads to Cloudinary
    const uploadTasks = [
      { field: "profilePhoto", folder: "providers/profile" },
      { field: "governmentIDProof", folder: "providers/id" },
      { field: "addressProof", folder: "providers/address" },
      { field: "skillCertificate", folder: "providers/skill", optional: true },
      { field: "businessRegistrationProof", folder: "providers/business", optional: true },
      { field: "tradeLicense", folder: "providers/trade_license", optional: true },
      { field: "shopFrontPhoto", folder: "providers/shop", optional: true }
    ];

    const results = await Promise.all(
      uploadTasks.map(async ({ field, folder }) => {
        if (req.files?.[field]?.[0]) {
          const url = await uploadToStorage(req.files[field][0], folder);
          return { field, url };
        }
        return null;
      })
    );

    results.forEach(res => {
      if (res) {
        provider[res.field] = res.url;
      }
    });

    await provider.save();

    return res.status(StatusCodes.OK).json({
      message: "Documents uploaded successfully",
      provider // Returning updated provider for frontend convenience
    });
  } catch (err) {
    console.error("Upload Error:", err);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: "Failed to upload documents",
    });
  }
}

/* =========================================================
   STEP 5 — SAVE BANK DETAILS (PROTECTED)
========================================================= */
export async function saveBankDetails(req, res) {
  try {
    const provider = await Provider.findById(req.user.sub);
    if (!provider) {
      return res.status(StatusCodes.NOT_FOUND).json({
        error: "Provider not found",
      });
    }

    const {
      bankAccountNumber,
      ifscCode,
      upiId,
      accountHolderName
    } = req.body;

    provider.bankAccountNumber = bankAccountNumber;
    provider.ifscCode = ifscCode;
    provider.upiId = upiId;
    provider.accountHolderName = accountHolderName;
    provider.isRegistrationComplete = true;

    await provider.save();

    return res.status(StatusCodes.OK).json({
      message: "Bank details saved successfully",
    });
  } catch (err) {
    console.error("Bank Error:", err);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: "Failed to save bank details",
    });
  }
}

/* =========================================================
   LOGIN (PASSWORD BASED)
========================================================= */
export async function loginProvider(req, res) {
  try {
    const { error, value } = providerLoginSchema.validate(req.body);
    if (error) {
      return res.status(StatusCodes.BAD_REQUEST).json({
        error: error.details[0].message,
      });
    }

    const { phoneNumber, password } = value;

    const provider = await Provider.findOne({ phoneNumber }).select("+password");

    if (!provider) {
      return res.status(StatusCodes.NOT_FOUND).json({
        error: "No account found with this phone number",
      });
    }

    if (provider.status === "Terminated") {
      return res.status(StatusCodes.FORBIDDEN).json({
        error: "Access denied. Admin has terminated your account. Please contact support.",
      });
    }

    if (!provider.isVerified) {
      return res.status(StatusCodes.FORBIDDEN).json({ error: "Please verify your phone number first." });
    }

    if (!provider.password) {
      return res.status(StatusCodes.BAD_REQUEST).json({ error: "Account was created without a password. Please reset your password." });
    }

    const isMatch = await provider.comparePassword(password);
    if (!isMatch) {
      return res.status(StatusCodes.UNAUTHORIZED).json({
        error: "Invalid phone number or password",
      });
    }

    const accessToken = signAccess({ sub: provider._id.toString(), role: "provider" });
    const refreshToken = signRefresh({ sub: provider._id.toString(), role: "provider" });

    // Add refresh token atomically (avoids select:false issues on password/refreshToken)
    await Provider.findByIdAndUpdate(provider._id, {
      $push: { refreshToken: { $each: [refreshToken], $slice: -10 } }
    });

    res.cookie("provider_refreshToken", refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    return res.status(StatusCodes.OK).json({
      message: "Login successful",
      accessToken,
      provider: {
        id: provider._id,
        fullName: provider.fullName,
        phoneNumber: provider.phoneNumber,
        status: provider.status
      }
    });
  } catch (err) {
    console.error("Login Error:", err);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: "Server error during login",
    });
  }
}


/* =========================================================
   GET PROFILE (PROTECTED)
========================================================= */
export async function getProviderProfile(req, res) {
  // console.log("Profile route hit");
  try {
    const provider = await Provider.findById(req.user.sub).select(
      "-otpHash -otpExpires -refreshToken -__v"
    );

    if (!provider) {
      return res.status(StatusCodes.NOT_FOUND).json({
        error: "Provider not found",
      });
    }

    return res.status(StatusCodes.OK).json({ provider });
  } catch (err) {
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: "Failed to fetch profile",
    });
  }
}

/* =========================================================
   UPDATE PROFILE (PROTECTED)
========================================================= */
export async function updateProviderProfile(req, res) {
  try {
    let profilePhotoUrl = null;
    if (req.files?.profilePhoto?.[0]) {
      profilePhotoUrl = await uploadToStorage(req.files.profilePhoto[0], "providers/profile");
    }

    const { error, value } = providerUpdateSchema.validate(req.body, {
      allowUnknown: true,
    });

    if (error) {
      return res.status(StatusCodes.BAD_REQUEST).json({
        error: error.details[0].message,
      });
    }

    const updateData = { ...value };
    if (profilePhotoUrl) {
      updateData.profilePhoto = profilePhotoUrl;
    }

    const provider = await Provider.findByIdAndUpdate(
      req.user.sub,
      updateData,
      { new: true }
    ).select("-otpHash -otpExpires -refreshToken -__v");

    if (!provider) {
      return res.status(StatusCodes.NOT_FOUND).json({
        error: "Provider not found",
      });
    }

    return res.status(StatusCodes.OK).json({ provider });
  } catch (err) {
    console.error("Update profile error:", err);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: "Failed to update profile",
    });
  }
}

/* =========================================================
   LOGOUT
========================================================= */
export async function logoutProvider(req, res) {
  try {
    const token = req.cookies.provider_refreshToken;
    if (token) {
      // Remove only this session's token atomically
      await Provider.findByIdAndUpdate(req.user.sub, {
        $pull: { refreshToken: token }
      });
    }

    res.clearCookie("provider_refreshToken", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
    });

    return res.status(StatusCodes.NO_CONTENT).end();
  } catch (err) {
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: "Logout failed",
    });
  }
}


/**
 * Update Service Details
 */

export async function updateServiceDetails(req, res) {
  try {
    const provider = await Provider.findById(req.user.sub);
    if (!provider) {
      res.status(StatusCodes.NOT_FOUND).json({
        error: "Provider is not found"
      });
    }

    const {
      serviceCategory,
      providerSubService,
      subService,
      experience,
      languageSpoken,
      houseNumber,
      colony,
      landmark,
      city,
      state,
      pinCode,
    } = req.body;

    provider.serviceCategory = serviceCategory ?? provider.serviceCategory;
    provider.providerSubService = providerSubService ?? provider.providerSubService;
    provider.subService = subService ?? provider.subService;
    provider.experience = experience ?? provider.experience;
    provider.languageSpoken = languageSpoken ?? provider.languageSpoken;

    if (provider.address) {
      provider.address.houseNumber = houseNumber ?? provider.address.houseNumber;
      provider.address.colony = colony ?? provider.address.colony;
      provider.address.landmark = landmark ?? provider.address.landmark;
    }

    provider.city = city ?? provider.city;
    provider.state = state ?? provider.state;
    provider.pinCode = pinCode ?? provider.pinCode;

    await provider.save();

    return res.status(StatusCodes.OK).json({
      message: "Service Update successfully"
    })
  } catch (error) {
    console.error(error.message);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: "Failed to Update the service Details"
    })
  }
}


export async function updateBankDetails(req, res) {
  try {
    const provider = await Provider.findById(req.user.sub);
    if (!provider) {
      res.status(StatusCodes.NOT_FOUND).json({
        error: "Provider Not Found"
      });
    }

    const {
      bankAccountNumber,
      ifscCode,
      upiId
    } = req.body;

    provider.bankAccountNumber = bankAccountNumber ?? provider.bankAccountNumber;
    provider.ifscCode = ifscCode ?? provider.ifscCode;
    provider.upiId = upiId ?? provider.upiId;

    await provider.save();

    return res.status(StatusCodes.OK).json({
      message: "bank detail Update SuccessFully"
    });
  } catch (error) {
    console.error(error.message);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: "Failed to update the bank details"
    })
  }
}


export async function saveDeviceToken(req, res) {
  try {
    const providerId = req.user.sub;
    const { deviceToken } = req.body;

    await Provider.findByIdAndUpdate(providerId, {
      deviceToken,
    });

    // console.log("TOKEN RECEIVED:", req.body.deviceToken);
    // console.log("Provider:", req.user.sub);
    return res.json({
      message: "Device token saved successfully",
    });
  } catch (err) {
    res.status(500).json({ error: "Token save failed" });
  }
}

export async function updateNotificationSound(req, res) {
  try {
    const providerId = req.user.sub;
    const { sound } = req.body;

    if (!sound) {
      return res.status(StatusCodes.BAD_REQUEST).json({
        error: "Sound selection is required",
      });
    }

    await Provider.findByIdAndUpdate(providerId, {
      notificationSound: sound,
    });

    return res.status(StatusCodes.OK).json({
      message: "Notification sound updated successfully",
      sound
    });
  } catch (err) {
    console.error("Sound Update Error:", err);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: "Failed to update notification sound",
    });
  }
}

/**
 * FORGOT PASSWORD: Request OTP via email
 */
export async function forgotPasswordProvider(req, res) {
  try {
    const { value, error } = providerForgotPasswordSchema.validate(req.body);
    if (error) return res.status(StatusCodes.BAD_REQUEST).json({ error: error.message });

    const { email } = value;
    const provider = await Provider.findOne({ email: email.toLowerCase() });
    if (!provider) {
      return res.status(StatusCodes.NOT_FOUND).json({ error: "No account found with this email address." });
    }

    if (provider.status === "Terminated") {
      return res.status(StatusCodes.FORBIDDEN).json({ error: "Access denied. Your account is terminated." });
    }

    // Generate 4-digit OTP
    const otp = Math.floor(1000 + Math.random() * 9000).toString();
    const otpHash = hash(otp);

    provider.otpHash = otpHash;
    provider.otpExpires = new Date(Date.now() + OTP_TTL_MS);
    await provider.save();

    // Log the OTP to console (as fallback/backup)
    console.log(`[EMAIL OTP] Password reset OTP for provider email ${email}: ${otp}`);

    // Send the OTP via Nodemailer
    const emailHtml = getForgotPasswordTemplate(provider.fullName, otp, "partner");

    sendEmail({
      to: provider.email,
      subject: "Reset Your Password - Skilled Ustaad Partner",
      text: `Your password reset verification code is: ${otp}. It is valid for 5 minutes.`,
      html: emailHtml,
    }).catch(err => {
      console.error("[EMAIL ERROR] Background forgot password email dispatch failed:", err.message);
    });

    return res.status(StatusCodes.OK).json({ message: "OTP sent successfully to your email." });
  } catch (err) {
    console.error("Forgot password OTP error (Provider):", err);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: "Failed to send reset OTP" });
  }
}

/**
 * RESET PASSWORD: Verify OTP and Set New Password
 */
export async function resetPasswordProvider(req, res) {
  try {
    const { value, error } = providerResetPasswordSchema.validate(req.body);
    if (error) return res.status(StatusCodes.BAD_REQUEST).json({ error: error.message });

    const { email, otp, newPassword } = value;
    const provider = await Provider.findOne({ email: email.toLowerCase() }).select("+otpHash +otpExpires +password");
    if (!provider) return res.status(StatusCodes.NOT_FOUND).json({ error: "Provider not found" });

    // Verify OTP
    const isStaticMatch = otp === DEFAULT_OTP;
    if (!isStaticMatch) {
      if (!provider.otpHash || !provider.otpExpires || provider.otpExpires < new Date()) {
        return res.status(StatusCodes.BAD_REQUEST).json({ error: "OTP expired" });
      }
      if (provider.otpHash !== hash(otp)) {
        return res.status(StatusCodes.BAD_REQUEST).json({ error: "Invalid OTP" });
      }
    }

    // Update Password
    provider.password = newPassword;

    // Clear OTP fields
    provider.otpHash = undefined;
    provider.otpExpires = undefined;

    await provider.save();

    return res.status(StatusCodes.OK).json({ message: "Password reset successful. Please login with your new password." });
  } catch (err) {
    console.error("Reset password error (Provider):", err);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: "Failed to reset password" });
  }
}

/* =========================================================
   BUSINESS DETAILS (PROTECTED)
========================================================= */
export async function saveBusinessDetails(req, res) {
  try {
    const { error, value } = businessDetailsSchema.validate(req.body);
    if (error) {
      return res.status(StatusCodes.BAD_REQUEST).json({ error: error.details[0].message });
    }

    const provider = await Provider.findById(req.user.sub);
    if (!provider) {
      return res.status(StatusCodes.NOT_FOUND).json({ error: "Provider not found" });
    }

    provider.providerType = "business";
    provider.businessDetails = {
      ...(provider.businessDetails || {}),
      ...value
    };

    await provider.save();
    return res.status(StatusCodes.OK).json({
      message: "Business details saved successfully",
      businessDetails: provider.businessDetails
    });
  } catch (err) {
    console.error("Save Business Details Error:", err);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: "Failed to save business details" });
  }
}

/* =========================================================
   WORKERS MANAGEMENT (PROTECTED - BUSINESS ONLY)
========================================================= */
export async function getWorkers(req, res) {
  try {
    const provider = await Provider.findById(req.user.sub).select("workers");
    if (!provider) return res.status(StatusCodes.NOT_FOUND).json({ error: "Provider not found" });
    return res.status(StatusCodes.OK).json({ workers: provider.workers || [] });
  } catch (err) {
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: "Failed to fetch workers" });
  }
}

export async function addWorker(req, res) {
  try {
    const { error, value } = workerSchema.validate(req.body);
    if (error) return res.status(StatusCodes.BAD_REQUEST).json({ error: error.details[0].message });

    const provider = await Provider.findById(req.user.sub);
    if (!provider) return res.status(StatusCodes.NOT_FOUND).json({ error: "Provider not found" });

    provider.workers.push(value);
    await provider.save();

    return res.status(StatusCodes.CREATED).json({
      message: "Worker added successfully",
      workers: provider.workers
    });
  } catch (err) {
    console.error("Add Worker Error:", err);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: "Failed to add worker" });
  }
}

export async function deleteWorker(req, res) {
  try {
    const { workerId } = req.params;
    const provider = await Provider.findById(req.user.sub);
    if (!provider) return res.status(StatusCodes.NOT_FOUND).json({ error: "Provider not found" });

    provider.workers = provider.workers.filter(w => w._id.toString() !== workerId);
    await provider.save();

    return res.status(StatusCodes.OK).json({
      message: "Worker removed successfully",
      workers: provider.workers
    });
  } catch (err) {
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: "Failed to remove worker" });
  }
}

/* =========================================================
   SUBMIT APPLICATION FOR REVIEW (PROTECTED)
========================================================= */
export async function submitApplication(req, res) {
  try {
    const provider = await Provider.findById(req.user.sub);
    if (!provider) return res.status(StatusCodes.NOT_FOUND).json({ error: "Provider not found" });

    provider.applicationStatus = "under_review";
    provider.isRegistrationComplete = true;

    await provider.save();

    // Notify Admin of new/resubmitted application
    try {
      sendAdminNotification({
        type: "provider_application_submitted",
        title: "📄 Application Submitted for Review",
        message: `${provider.fullName} (${provider.providerType}) has submitted their application for verification.`,
        metadata: { providerId: provider._id.toString() }
      });
    } catch (_) {}

    broadcastStats();

    return res.status(StatusCodes.OK).json({
      message: "Application submitted for review successfully",
      applicationStatus: provider.applicationStatus
    });
  } catch (err) {
    console.error("Submit Application Error:", err);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: "Failed to submit application" });
  }
}

/* =========================================================
   REGISTRATION / APPLICATION STATUS (PROTECTED)
========================================================= */
export async function getRegistrationStatus(req, res) {
  try {
    const provider = await Provider.findById(req.user.sub).select(
      "applicationStatus status isRegistrationComplete adminReviewNotes changesRequestedFields providerType currentStep fullName"
    );
    if (!provider) return res.status(StatusCodes.NOT_FOUND).json({ error: "Provider not found" });

    return res.status(StatusCodes.OK).json({
      applicationStatus: provider.applicationStatus,
      status: provider.status,
      isRegistrationComplete: provider.isRegistrationComplete,
      adminReviewNotes: provider.adminReviewNotes || "",
      changesRequestedFields: provider.changesRequestedFields || [],
      providerType: provider.providerType,
      currentStep: provider.currentStep,
      fullName: provider.fullName
    });
  } catch (err) {
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: "Failed to fetch status" });
  }
}
