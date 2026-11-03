import express from "express";
import {
  registerProvider,
  verifyProviderOTP,
  loginProvider,
  refreshToken,
  logoutProvider,
  getProviderProfile,
  saveServiceDetails,
  saveBankDetails,
  updateProviderProfile,
  updateServiceDetails,
  uploadDocuments,
  updateBankDetails,
  saveDeviceToken,
  updateNotificationSound,
  forgotPasswordProvider,
  resetPasswordProvider,
  saveBusinessDetails,
  getWorkers,
  addWorker,
  deleteWorker,
  submitApplication,
  getRegistrationStatus
} from "../controllers/provider.controller.js";
import { upload } from "../middleware/uploadMiddleware.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { requireRegistrationComplete } from "../middleware/requireRegistrationComplete.js";
import validate from "../middleware/validate.js";
import { providerRegisterSchema, providerLoginSchema, providerVerifySchema, serviceSchema, bankSchema } from "../validations/schemas.js";

const router = express.Router();


/**
 * Auth , otp verification
 */
router.post("/register", validate(providerRegisterSchema), registerProvider);
router.post("/verify-otp", validate(providerVerifySchema), verifyProviderOTP);
router.post("/login", validate(providerLoginSchema), loginProvider);
router.post("/forgot-password", forgotPasswordProvider);
router.post("/reset-password", resetPasswordProvider);
router.post("/refresh-token", refreshToken);
router.post("/logout",requireAuth,logoutProvider);

/**
 * service detail
 */
router.post("/service-details", requireAuth, validate(serviceSchema), saveServiceDetails);

/**
 * Document Upload
 */
router.post(
  "/documents",
  
  upload.fields([
    {name:"profilePhoto",maxCount:1},
    {name:"governmentIDProof",maxCount:1},
    {name:"addressProof",maxCount:1}, 
    {name:"skillCertificate",maxCount:1},
    {name:"businessRegistrationProof",maxCount:1},
    {name:"tradeLicense",maxCount:1},
    {name:"shopFrontPhoto",maxCount:1},
  ]),
  requireAuth,
  uploadDocuments,
);

/**
 * Bank Details
 */

router.post("/bank-details", requireAuth, validate(bankSchema), saveBankDetails);

/**
 * Business Details & Workers (Business Provider flow)
 */
router.post("/business-details", requireAuth, saveBusinessDetails);
router.get("/workers", requireAuth, getWorkers);
router.post("/workers", requireAuth, addWorker);
router.delete("/workers/:workerId", requireAuth, deleteWorker);

/**
 * Application Lifecycle & Review Submission
 */
router.post("/submit-application", requireAuth, submitApplication);
router.get("/registration-status", requireAuth, getRegistrationStatus);

/**
 * getProviderProfile
 */
router.get("/profile",requireAuth,getProviderProfile);

/**
 * update profile photo
 */
router.post(
  "/update-provider-profile",
  upload.fields([{ name: "profilePhoto", maxCount: 1 }]),
  requireAuth,
  requireRegistrationComplete,
  updateProviderProfile
);

/*
* update Service Details, 
*/
router.put("/service-details-update", requireAuth, requireRegistrationComplete, validate(serviceSchema), updateServiceDetails);

/**
 * 
 */
router.put("/bank-details-update", requireAuth, requireRegistrationComplete, validate(bankSchema), updateBankDetails);


router.post(
  "/save-token",
  requireAuth,
  requireRegistrationComplete,
  saveDeviceToken
);

import {
  getSubscriptionStatus,
  createSubscriptionOrder,
  verifySubscriptionPayment,
} from "../controllers/subscription.controller.js";

router.post(
  "/notification-sound",
  requireAuth,
  requireRegistrationComplete,
  updateNotificationSound
);

/**
 * Subscription Routes
 */
router.get("/subscription/status", requireAuth, getSubscriptionStatus);
router.post("/subscription/create-order", requireAuth, createSubscriptionOrder);
router.post("/subscription/verify-payment", requireAuth, verifySubscriptionPayment);

export default router;



