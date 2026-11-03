import Provider from "../models/Provider.js";
import { StatusCodes } from "http-status-codes";

export async function requireRegistrationComplete(req, res, next) {
  try {
    // Only apply checks for providers
    if (req.user && req.user.role === "provider") {
      const provider = await Provider.findById(req.user.sub);
      if (!provider) {
        return res.status(StatusCodes.NOT_FOUND).json({ error: "Provider not found" });
      }

      // Check Application Review lifecycle
      if (provider.applicationStatus === "under_review") {
        return res.status(StatusCodes.FORBIDDEN).json({
          error: "Your application is currently under review by our admin team.",
          applicationStatus: "under_review",
          underReview: true
        });
      }

      if (provider.applicationStatus === "changes_needed") {
        return res.status(StatusCodes.FORBIDDEN).json({
          error: "Admin requested changes in your registration details.",
          applicationStatus: "changes_needed",
          changesNeeded: true,
          adminReviewNotes: provider.adminReviewNotes || "",
          changesRequestedFields: provider.changesRequestedFields || []
        });
      }

      // Check if registration is complete
      // Backward compatibility: If bank details and service category are filled, treat it as complete
      const isComplete =
        provider.isRegistrationComplete ||
        provider.applicationStatus === "approved" ||
        provider.status === "Active" ||
        (provider.bankAccountNumber && provider.upiId && provider.serviceCategory);

      if (!isComplete) {
        return res.status(StatusCodes.FORBIDDEN).json({
          error: "Registration incomplete. Please complete all steps of registration.",
          registrationIncomplete: true,
          applicationStatus: provider.applicationStatus || "draft"
        });
      }
    }
    next();
  } catch (err) {
    console.error("requireRegistrationComplete error:", err);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: "Server error verifying registration status" });
  }
}
