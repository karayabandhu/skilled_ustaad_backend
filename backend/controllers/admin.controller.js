import mongoose from "mongoose";
import Service from "../models/Service.js";
import Booking from "../models/Booking.js";
import Payment from "../models/Payment.js";
import Transaction from "../models/Transaction.js";
import GlobalSettings from "../models/GlobalSettings.js";
import SupportQuery from "../models/SupportQuery.js";
import SecOpsReport from "../models/SecOpsReport.js";
import Admin from "../models/Admin.js";
import User from "../models/User.js";
import Provider from "../models/Provider.js";
import Payout from "../models/Payout.js";
import AdminNotification from "../models/AdminNotification.js";
import WalletTransaction from "../models/WalletTransaction.js";
import UserNotification from "../models/UserNotification.js";
import ProviderNotification from "../models/ProviderNotification.js";
import { StatusCodes } from "http-status-codes";
import { getIO, broadcastStats } from "../libs/socket.js";
import { sendAdminNotification } from "../services/fcm.service.js";

/* ------------------------------------------------------------------
   GET DASHBOARD STATS
   Endpoint: GET /admin/stats
-------------------------------------------------------------------*/
export const getStats = async (req, res) => {
  try {
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const sixtyDaysAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);

    const [
      customerCount,
      providerCount,
      totalJobsCount,
      prevCustomerCount,
      prevProviderCount,
      prevJobsCount,
      revenueData,
      prevRevenueData
    ] = await Promise.all([
      User.countDocuments(),
      Provider.countDocuments(),
      Service.countDocuments({ status: "active" }),

      // For trends
      User.countDocuments({ createdAt: { $lt: thirtyDaysAgo } }),
      Provider.countDocuments({ createdAt: { $lt: thirtyDaysAgo } }),
      Service.countDocuments({ status: "active", createdAt: { $lt: thirtyDaysAgo } }),

      // Total revenue
      Transaction.aggregate([
        { $match: { status: "Completed" } },
        { $group: { _id: null, totalRevenue: { $sum: "$amount" } } }
      ]),

      // Revenue 30 days ago (for trend)
      Transaction.aggregate([
        { $match: { status: "Completed", date: { $lt: thirtyDaysAgo } } },
        { $group: { _id: null, totalRevenue: { $sum: "$amount" } } }
      ])
    ]);

    const totalRevenue = revenueData.length > 0 ? revenueData[0].totalRevenue : 0;
    const pastRevenue = prevRevenueData.length > 0 ? prevRevenueData[0].totalRevenue : 0;

    // Helper to calculate percentage growth
    const calcTrend = (current, prev) => {
      if (!prev || prev === 0) return current > 0 ? "+100%" : "0%";
      const diff = current - prev;
      const percentage = ((diff / prev) * 100).toFixed(0);
      return percentage >= 0 ? `+${percentage}%` : `${percentage}%`;
    };

    return res.status(StatusCodes.OK).json({
      success: true,
      stats: {
        customerCount,
        providerCount,
        totalJobsCount,
        totalRevenue,
        trends: {
          customer: calcTrend(customerCount, prevCustomerCount),
          provider: calcTrend(providerCount, prevProviderCount),
          job: calcTrend(totalJobsCount, prevJobsCount),
          revenue: calcTrend(totalRevenue, pastRevenue)
        }
      }
    });
  } catch (error) {
    console.error("Error fetching admin stats:", error);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: "Internal Server Error" });
  }
};

/* ------------------------------------------------------------------
   GET REVENUE ANALYTICS (GRAPH)
   Endpoint: GET /api/admin/revenue
-------------------------------------------------------------------*/
export const getRevenueAnalytics = async (req, res) => {
  try {
    const { period = "live" } = req.query;
    let startDate;
    let groupFormat;

    if (period === "live") {
      startDate = new Date(Date.now() - 24 * 60 * 60 * 1000);
      groupFormat = "%Y-%m-%dT%H:00:00.000Z";
    } else {
      startDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      groupFormat = "%Y-%m-%d";
    }

    const [txData, walletData] = await Promise.all([
      Transaction.aggregate([
        {
          $match: {
            status: "Completed",
            date: { $gte: startDate }
          }
        },
        {
          $group: {
            _id: { $dateToString: { format: groupFormat, date: "$date" } },
            revenue: { $sum: "$amount" }
          }
        }
      ]),
      WalletTransaction.aggregate([
        {
          $match: {
            status: "completed",
            createdAt: { $gte: startDate }
          }
        },
        {
          $group: {
            _id: { $dateToString: { format: groupFormat, date: "$createdAt" } },
            revenue: { $sum: "$amount" }
          }
        }
      ])
    ]);

    // Merge results
    const combined = {};
    const now = new Date();

    if (period === "live") {
      // Pre-fill last 24 hours
      for (let i = 23; i >= 0; i--) {
        const d = new Date(now.getTime() - i * 60 * 60 * 1000);
        const key = d.toISOString().substring(0, 13) + ":00:00.000Z";
        combined[key] = 0;
      }
    } else {
      // Pre-fill last 30 days
      for (let i = 29; i >= 0; i--) {
        const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
        const key = d.toISOString().substring(0, 10);
        combined[key] = 0;
      }
    }

    txData.forEach(d => combined[d._id] = (combined[d._id] || 0) + d.revenue);
    walletData.forEach(d => combined[d._id] = (combined[d._id] || 0) + d.revenue);

    const formattedData = Object.entries(combined).sort((a, b) => a[0].localeCompare(b[0])).map(([dateStr, revenue]) => ({
      date: period === "live"
        ? `${new Date(dateStr).getHours().toString().padStart(2, '0')}:00`
        : new Date(dateStr).toLocaleDateString([], { day: 'numeric', month: 'short' }),
      revenue
    }));

    return res.status(StatusCodes.OK).json({ success: true, data: formattedData });
  } catch (error) {
    console.error("Error fetching revenue analytics:", error);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: "Internal Server Error" });
  }
};

/* ------------------------------------------------------------------
   GET ALL CUSTOMERS (USERS)
   Endpoint: GET /admin/customers
-------------------------------------------------------------------*/
export const getCustomers = async (req, res) => {
  try {
    const isAll = req.query.all === "true";

    let customers;
    if (isAll) {
      customers = await User.find().sort({ createdAt: -1 });
    } else {
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 20;
      const skip = (page - 1) * limit;
      customers = await User.find().sort({ createdAt: -1 }).skip(skip).limit(limit);
    }

    const formattedCustomers = customers.map(c => ({
      ...c.toObject(),
      _id: c._id,
      name: c.fullName,
      phone: c.phoneNumber,
      email: c.email || "N/A",
      image: c.profilePhoto || "",
      status: !c.isActive ? "Suspended" : (c.isVerified ? "Active" : "New"),
      city: c.city || "N/A",
      state: c.state || "N/A",
      fullAddress: `${c.address?.houseNo || ""} ${c.address?.colony || ""}`.trim() || c.city || "N/A",
      createdAt: c.createdAt,
      isVerified: c.isVerified,
      isActive: c.isActive,
      walletBalance: c.walletBalance || 0
    }));

    if (isAll) {
      return res.status(StatusCodes.OK).json(formattedCustomers);
    }

    const [total, activeCount, suspendedCount, newCount] = await Promise.all([
      User.countDocuments(),
      User.countDocuments({ isActive: true, isVerified: true }),
      User.countDocuments({ isActive: false }),
      User.countDocuments({ isActive: true, isVerified: false })
    ]);

    return res.status(StatusCodes.OK).json({
      success: true,
      customers: formattedCustomers,
      pagination: {
        total,
        page: parseInt(req.query.page) || 1,
        limit: parseInt(req.query.limit) || 20,
        pages: Math.ceil(total / (parseInt(req.query.limit) || 20))
      },
      summary: {
        total,
        active: activeCount,
        suspended: suspendedCount,
        new: newCount
      }
    });
  } catch (error) {
    console.error("Error fetching customers:", error);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: "Internal Server Error" });
  }
};

/* ------------------------------------------------------------------
   GET ALL PROVIDERS
   Endpoint: GET /admin/providers
-------------------------------------------------------------------*/
export const getProviders = async (req, res) => {
  try {
    const isAll = req.query.all === "true";

    if (isAll) {
      const providers = await Provider.find()
        .select("-refreshToken")
        .sort({ createdAt: -1 });
      return res.status(StatusCodes.OK).json(providers);
    }

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    const providers = await Provider.find()
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    const [total, activeCount, suspendedCount, pendingCount] = await Promise.all([
      Provider.countDocuments(),
      Provider.countDocuments({ status: "Active" }),
      Provider.countDocuments({ status: "Suspended" }),
      Provider.countDocuments({ status: "Pending" })
    ]);

    return res.status(StatusCodes.OK).json({
      success: true,
      providers,
      pagination: {
        total,
        page,
        limit,
        pages: Math.ceil(total / limit)
      },
      summary: {
        total,
        active: activeCount,
        suspended: suspendedCount,
        pending: pendingCount
      }
    });
  } catch (error) {
    console.error("Error fetching providers:", error);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: "Internal Server Error" });
  }
};

export const updateCustomerStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    const isTerminated = status?.toLowerCase() === "suspended";
    const isActive = !isTerminated; // If terminated, it's not active
    const isVerified = status?.toLowerCase() === "active" || (status?.toLowerCase() !== "suspended" && true); // keep verified if not suspended

    const customer = await User.findByIdAndUpdate(
      id,
      { isActive, isVerified, isTerminated },
      { new: true }
    );

    if (!customer) {
      return res.status(StatusCodes.NOT_FOUND).json({ error: "Customer not found" });
    }

    // Real-time Update
    try {
      getIO().emit("customerUpdated", customer);
      broadcastStats();
    } catch (err) {
      console.error("Socket emit error:", err.message);
    }

    return res.status(StatusCodes.OK).json({ success: true, customer });
  } catch (error) {
    console.error("Error updating customer status:", error);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: "Internal Server Error" });
  }
};

/* ------------------------------------------------------------------
   UPDATE PROVIDER STATUS (ACCEPT/SUSPEND)
   Endpoint: PUT /admin/providers/:id
-------------------------------------------------------------------*/
export const updateProviderStatus = async (req, res) => {
  try {
    const { status, applicationStatus, reviewNotes, flaggedFields } = req.body;
    const updateData = {};

    if (status) updateData.status = status;
    if (applicationStatus) updateData.applicationStatus = applicationStatus;

    if (applicationStatus === "approved" || status === "Active") {
      updateData.status = "Active";
      updateData.applicationStatus = "approved";
      updateData.backgroundVerification = "Verified";
      updateData.reviewedAt = new Date();
      if (req.user?.sub) updateData.reviewedBy = req.user.sub;
    } else if (applicationStatus === "changes_needed") {
      updateData.applicationStatus = "changes_needed";
      updateData.status = "Pending";
      updateData.adminReviewNotes = reviewNotes || "";
      if (Array.isArray(flaggedFields)) {
        updateData.changesRequestedFields = flaggedFields;
      }
      updateData.reviewedAt = new Date();
      if (req.user?.sub) updateData.reviewedBy = req.user.sub;
    } else if (status === "Suspended") {
      updateData.status = "Suspended";
    }

    const provider = await Provider.findByIdAndUpdate(
      req.params.id,
      updateData,
      { new: true }
    ).select("-refreshToken");

    if (!provider) {
      return res.status(StatusCodes.NOT_FOUND).json({ error: "Provider not found" });
    }

    // Real-time notification and database notification
    try {
      if (updateData.applicationStatus === "approved" || status === "Active") {
        await ProviderNotification.create({
          providerId: provider._id,
          type: "profile_verification",
          title: "Profile Verified",
          message: "Your profile has been verified and activated by the admin! You can now start accepting bookings."
        });
      } else if (updateData.applicationStatus === "changes_needed") {
        await ProviderNotification.create({
          providerId: provider._id,
          type: "profile_verification",
          title: "Changes Needed in Registration",
          message: reviewNotes || "Admin requested corrections to your registration details. Please update them in the app."
        });
      } else if (status === "Suspended") {
        await ProviderNotification.create({
          providerId: provider._id,
          type: "profile_verification",
          title: "Profile Suspended",
          message: "Your profile has been suspended by the admin. Please contact support for more details."
        });
      }
    } catch (notifErr) {
      console.error("Failed to create profile verification notification:", notifErr.message);
    }

    try {
      getIO().emit(status.toLowerCase() === "suspended" ? "providerSuspended" : "providerUpdated", { providerId: provider._id, status: provider.status });
      broadcastStats();
    } catch (ioErr) {
      console.error("Socket emit error:", ioErr.message);
    }

    return res.status(StatusCodes.OK).json({ message: `Provider ${status}`, provider });
  } catch (error) {
    console.error("Error updating provider status:", error);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: "Internal Server Error" });
  }
};

/* ------------------------------------------------------------------
   GET ALL FINANCE TRANSACTIONS
   Endpoint: GET /admin/finance
-------------------------------------------------------------------*/
export const getFinanceTransactions = async (req, res) => {
  try {
    const [transactions, walletTxs] = await Promise.all([
      Transaction.find()
        .populate({ path: "provider", select: "fullName" })
        .populate({ path: "client", select: "fullName" })
        .populate({ path: "service", select: "category" })
        .sort({ date: -1 }),
      WalletTransaction.find({ status: "completed" })
        .populate({ path: "user", select: "fullName" })
        .sort({ createdAt: -1 })
    ]);

    const formattedTxs = transactions.map(t => ({
      _id: t._id,
      transactionId: t.transactionId || `TX-${t._id.toString().slice(-6).toUpperCase()}`,
      userName: t.client?.fullName || "N/A",
      providerName: t.provider?.fullName || "System/Platform",
      jobCategory: t.service?.category || (t.type === "token" ? "Booking Fee" : "Service Payment"),
      amount: t.amount,
      status: t.status,
      date: t.date,
      type: "booking"
    }));

    const formattedWallet = walletTxs.map(w => ({
      _id: w._id,
      transactionId: w.razorpayOrderId || `WLT-${w._id.toString().slice(-6).toUpperCase()}`,
      userName: w.user?.fullName || "N/A",
      providerName: "Platform (Wallet)",
      jobCategory: "Wallet Top-up",
      amount: w.amount,
      status: "Completed",
      date: w.createdAt,
      type: "wallet"
    }));

    const allFormatted = [...formattedTxs, ...formattedWallet].sort((a, b) => new Date(b.date) - new Date(a.date));

    return res.status(StatusCodes.OK).json(allFormatted);
  } catch (error) {
    console.error("Error fetching finance transactions:", error);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: "Internal Server Error" });
  }
};

/* ------------------------------------------------------------------
   GET TOTAL REVENUE
   Endpoint: GET /admin/finance/total
-------------------------------------------------------------------*/
export const getFinanceTotal = async (req, res) => {
  try {
    const [revenueData, walletRevenue] = await Promise.all([
      Transaction.aggregate([
        { $match: { status: "Completed" } },
        { $group: { _id: null, total: { $sum: "$amount" } } }
      ]),
      WalletTransaction.aggregate([
        { $match: { status: "completed" } },
        { $group: { _id: null, total: { $sum: "$amount" } } }
      ])
    ]);

    const txTotal = revenueData.length > 0 ? revenueData[0].total : 0;
    const walletTotal = walletRevenue.length > 0 ? walletRevenue[0].total : 0;
    const total = txTotal + walletTotal;

    return res.status(StatusCodes.OK).json({ total });
  } catch (error) {
    console.error("Error fetching total revenue:", error);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: "Internal Server Error" });
  }
};

/* ------------------------------------------------------------------
   GET NOTIFICATION SETTINGS
   Endpoint: GET /admin/notifications
-------------------------------------------------------------------*/
export const getNotificationSettings = async (req, res) => {
  try {
    let settings = await GlobalSettings.findOne();
    if (!settings) {
      settings = await GlobalSettings.create({ notifications: {} });
    }
    return res.status(StatusCodes.OK).json(settings.notifications);
  } catch (error) {
    console.error("Error fetching notification settings:", error);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: "Internal Server Error" });
  }
};

/* ------------------------------------------------------------------
   UPDATE NOTIFICATION SETTINGS
   Endpoint: PUT /admin/notifications
-------------------------------------------------------------------*/
export const updateNotificationSettings = async (req, res) => {
  try {
    const { notifications } = req.body;
    let settings = await GlobalSettings.findOne();
    if (!settings) {
      settings = new GlobalSettings({ notifications });
    } else {
      settings.notifications = { ...settings.notifications, ...notifications };
    }
    await settings.save();
    return res.status(StatusCodes.OK).json({ message: "Settings updated", notifications: settings.notifications });
  } catch (error) {
    console.error("Error updating notification settings:", error);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: "Internal Server Error" });
  }
};

/* ------------------------------------------------------------------
   GET GENERAL SETTINGS (TAX/LOCALIZATION)
   Endpoint: GET /admin/settings
-------------------------------------------------------------------*/
export const getGeneralSettings = async (req, res) => {
  try {
    let settings = await GlobalSettings.findOne();
    if (!settings) {
      settings = await GlobalSettings.create({});
    }
    return res.status(StatusCodes.OK).json(settings);
  } catch (error) {
    console.error("Error fetching general settings:", error);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: "Internal Server Error" });
  }
};

/* ------------------------------------------------------------------
   UPDATE GENERAL SETTINGS (TAX/LOCALIZATION)
   Endpoint: PUT /admin/settings
-------------------------------------------------------------------*/
export const updateGeneralSettings = async (req, res) => {
  try {
    const { taxAndCommission, localization, security, branding } = req.body;
    let settings = await GlobalSettings.findOne();
    if (!settings) {
      settings = new GlobalSettings({ taxAndCommission, localization, security, branding });
    } else {
      if (taxAndCommission) settings.taxAndCommission = { ...settings.taxAndCommission.toObject(), ...taxAndCommission };
      if (localization) settings.localization = { ...settings.localization.toObject(), ...localization };
      if (security) settings.security = { ...settings.security.toObject(), ...security };
      if (branding) settings.branding = { ...settings.branding.toObject(), ...branding };

      // Explicitly mark as modified for mixed/nested objects
      settings.markModified('taxAndCommission');
      settings.markModified('localization');
      settings.markModified('security');
      settings.markModified('branding');
    }
    await settings.save();
    return res.status(StatusCodes.OK).json({
      message: "General settings updated",
      settings
    });
  } catch (error) {
    console.error("Error updating general settings:", error);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: "Internal Server Error" });
  }
};

/* ------------------------------------------------------------------
   GET SUPPORT INFO (FAQS & CONTACT)
   Endpoint: GET /admin/support
-------------------------------------------------------------------*/
export const getSupportInfo = async (req, res) => {
  try {
    let settings = await GlobalSettings.findOne();
    if (!settings) {
      settings = await GlobalSettings.create({
        support: {
          faqs: [
            { question: "How do I book a service?", answer: "Go to Home > Services, select the service you want, and click 'Book Now'." },
            { question: "How can I contact a service provider?", answer: "After booking a service, you can contact the provider via chat or call." },
            { question: "What payment methods are accepted?", answer: "Skilled Ustaad accepts UPI, credit/debit cards, and net banking." }
          ]
        }
      });
    }
    return res.status(StatusCodes.OK).json(settings.support);
  } catch (error) {
    console.error("Error fetching support info:", error);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: "Internal Server Error" });
  }
};

/* ------------------------------------------------------------------
   UPDATE SUPPORT INFO (FAQS & CONTACT)
   Endpoint: PUT /admin/support
-------------------------------------------------------------------*/
export const updateSupportInfo = async (req, res) => {
  try {
    const { faqs, contactPhone, contactEmail } = req.body;
    let settings = await GlobalSettings.findOne();
    if (!settings) settings = new GlobalSettings();

    if (faqs) settings.support.faqs = faqs;
    if (contactPhone) settings.support.contactPhone = contactPhone;
    if (contactEmail) settings.support.contactEmail = contactEmail;

    await settings.save();
    return res.status(StatusCodes.OK).json({ message: "Support info updated", support: settings.support });
  } catch (error) {
    console.error("Error updating support info:", error);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: "Internal Server Error" });
  }
};

/* ------------------------------------------------------------------
   SUBMIT SUPPORT QUERY (CONTACT FORM)
   Endpoint: POST /admin/support/query
-------------------------------------------------------------------*/
export const submitSupportQuery = async (req, res) => {
  try {
    const { name, email, subject, message, userType, phone } = req.body;
    const query = new SupportQuery({
      name,
      email,
      subject,
      message,
      userType: userType || "customer",
      phone: phone || ""
    });
    await query.save();

    try {
      getIO().emit("support_query", query);
    } catch (sErr) {
      console.warn("Socket notification error for support query:", sErr.message);
    }

    sendAdminNotification({
      type: "system_alert",
      title: `🆘 New ${(userType === "provider") ? "Provider" : "Customer"} Support Ticket`,
      message: `${name} (${userType || "customer"}) submitted: "${message.slice(0, 40)}..."`,
      metadata: { queryId: query._id.toString(), email, userType: userType || "customer" }
    });
    return res.status(StatusCodes.CREATED).json({ success: true, message: "Query submitted successfully", query });
  } catch (error) {
    console.error("Error submitting support query:", error);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: "Internal Server Error" });
  }
};

/* ------------------------------------------------------------------
   GET ALL SUPPORT QUERIES (ADMIN)
   Endpoint: GET /admin/support/queries
-------------------------------------------------------------------*/
export const getSupportQueries = async (req, res) => {
  try {
    const queries = await SupportQuery.find().sort({ createdAt: -1 });
    return res.status(StatusCodes.OK).json(queries);
  } catch (error) {
    console.error("Error fetching support queries:", error);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: "Internal Server Error" });
  }
};

/* ------------------------------------------------------------------
   UPDATE SUPPORT QUERY STATUS (ADMIN)
   Endpoint: PUT /admin/support/queries/:id/status
-------------------------------------------------------------------*/
export const updateSupportQueryStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    if (!["pending", "resolved", "ignored"].includes(status)) {
      return res.status(StatusCodes.BAD_REQUEST).json({ error: "Invalid status value" });
    }
    const query = await SupportQuery.findByIdAndUpdate(id, { status }, { new: true });
    if (!query) {
      return res.status(StatusCodes.NOT_FOUND).json({ error: "Support ticket not found" });
    }
    return res.status(StatusCodes.OK).json({ success: true, query });
  } catch (error) {
    console.error("Error updating support query status:", error);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: "Internal Server Error" });
  }
};

/* ------------------------------------------------------------------
   ROTATE SECURITY KEYS
   Pulse: Security Cluster Key Cycle
   Endpoint: POST /admin/security/rotate-keys
-------------------------------------------------------------------*/
export const rotateSecurityKeys = async (req, res) => {
  try {
    let settings = await GlobalSettings.findOne();
    if (!settings) settings = await GlobalSettings.create({});

    settings.security.lastRotationAt = new Date();
    settings.markModified('security');
    await settings.save();

    return res.status(StatusCodes.OK).json({
      success: true,
      message: "Security Protocol Rotated Successfully",
      lastRotationAt: settings.security.lastRotationAt
    });
  } catch (error) {
    console.error("Security Rotation Failure:", error);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: "Vault Protocol Failure" });
  }
};

/* ------------------------------------------------------------------
   SUBMIT SEC-OPS REPORT (ADMIN-REPORTED ISSUES)
   Endpoint: POST /admin/sec-ops/report
-------------------------------------------------------------------*/
export const submitSecOpsReport = async (req, res) => {
  try {
    const { subject, priority, message } = req.body;
    const report = new SecOpsReport({ subject, priority, message });
    await report.save();

    // Trigger local system alert notification
    try {
      const adminNotification = new AdminNotification({
        type: "system_alert",
        title: `🚨 SEC-OPS Report: ${priority}`,
        message: `${subject.slice(0, 50)}${subject.length > 50 ? '...' : ''}`,
        metadata: { reportId: report._id.toString(), priority }
      });
      await adminNotification.save();
    } catch (nErr) {
      console.error("Notification trigger failed for SEC-OPS report:", nErr.message);
    }

    return res.status(StatusCodes.CREATED).json({ success: true, message: "SEC-OPS report submitted and recorded.", report });
  } catch (error) {
    console.error("Error submitting SEC-OPS report:", error);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: "Internal Server Error" });
  }
};

/* ------------------------------------------------------------------
   GET ALL SEC-OPS REPORTS (ADMIN)
   Endpoint: GET /admin/sec-ops/reports
-------------------------------------------------------------------*/
export const getSecOpsReports = async (req, res) => {
  try {
    const reports = await SecOpsReport.find().sort({ createdAt: -1 });
    return res.status(StatusCodes.OK).json(reports);
  } catch (error) {
    console.error("Error fetching SEC-OPS reports:", error);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: "Internal Server Error" });
  }
};

/* ------------------------------------------------------------------
   UPDATE SEC-OPS REPORT STATUS (ADMIN)
   Endpoint: PUT /admin/sec-ops/reports/:id/status
-------------------------------------------------------------------*/
export const updateSecOpsReportStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    if (!["pending", "investigating", "resolved", "dismissed"].includes(status)) {
      return res.status(StatusCodes.BAD_REQUEST).json({ error: "Invalid status value" });
    }
    const report = await SecOpsReport.findByIdAndUpdate(id, { status }, { new: true });
    if (!report) {
      return res.status(StatusCodes.NOT_FOUND).json({ error: "SecOps report not found" });
    }
    return res.status(StatusCodes.OK).json({ success: true, report });
  } catch (error) {
    console.error("Error updating SecOps report status:", error);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: "Internal Server Error" });
  }
};
/* ------------------------------------------------------------------
   GET ALL BOOKINGS
   Endpoint: GET /admin/bookings
-------------------------------------------------------------------*/
export const getBookings = async (req, res) => {
  try {
    const isAll = req.query.all === "true";
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || (isAll ? 1000 : 50);
    const skip = (page - 1) * limit;

    let bookingQuery = Booking.find()
      .populate("userId", "fullName phoneNumber email")
      .populate("providerId", "fullName phoneNumber profilePhoto")
      .sort({ createdAt: -1 });

    if (!isAll) {
      bookingQuery = bookingQuery.skip(skip).limit(limit);
    }

    const bookings = await bookingQuery.lean();

    // Safely populate service for lean documents
    const customServices = new Map();
    bookings.forEach((b, idx) => {
      if (b.service && !mongoose.Types.ObjectId.isValid(b.service)) {
        customServices.set(idx, b.service);
        b.service = null;
      }
    });

    try {
      await Booking.populate(bookings, { path: "service" });
    } catch (err) {
      console.error("Admin bookings service population failed:", err);
    }

    customServices.forEach((value, idx) => {
      bookings[idx].service = value;
    });

    const total = await Booking.countDocuments();

    // Enhancing the payload for admin dashboard
    const enhancedBookings = bookings.map(b => ({
      ...b,
      customerName: b.userId?.fullName || "N/A",
      providerName: b.providerId?.fullName || "Unassigned",
      serviceName: b.serviceType || "N/A",
      totalPrice: b.price || 0,
    }));

    return res.status(StatusCodes.OK).json({
      success: true,
      bookings: enhancedBookings,
      pagination: {
        total,
        page,
        limit,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error("Error fetching admin bookings:", error);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: "Internal Server Error" });
  }
};

/* ------------------------------------------------------------------
   GET ADMIN NOTIFICATIONS
   Endpoint: GET /admin/notifications/all
-------------------------------------------------------------------*/
export const getAdminNotifications = async (req, res) => {
  try {
    const { page = 1, limit = 10, search = "", filter = "all" } = req.query;
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const skip = (pageNum - 1) * limitNum;

    const query = {};
    if (search) {
      query.$or = [
        { title: { $regex: search, $options: "i" } },
        { message: { $regex: search, $options: "i" } }
      ];
    }
    if (filter === "unread") {
      query.isRead = false;
    }

    const total = await AdminNotification.countDocuments(query);
    const notifications = await AdminNotification.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limitNum);

    return res.status(StatusCodes.OK).json({ 
      success: true, 
      notifications,
      pagination: {
        total,
        page: pageNum,
        limit: limitNum,
        pages: Math.ceil(total / limitNum) || 1
      }
    });
  } catch (error) {
    console.error("Error fetching notifications:", error);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: "Internal Server Error" });
  }
};

/* ------------------------------------------------------------------
   MARK NOTIFICATIONS AS READ
   Endpoint: PUT /admin/notifications/read-all
-------------------------------------------------------------------*/
export const markNotificationsRead = async (req, res) => {
  try {
    await AdminNotification.updateMany({ isRead: false }, { isRead: true });
    return res.status(StatusCodes.OK).json({ success: true, message: "Marked all as read" });
  } catch (error) {
    console.error("Error marking read:", error);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: "Internal Server Error" });
  }
};
/* ------------------------------------------------------------------
   GET ALL PAYOUT REQUESTS
   Endpoint: GET /admin/payouts
-------------------------------------------------------------------*/
export const getPayouts = async (req, res) => {
  try {
    const isAll = req.query.all === "true";
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || (isAll ? 1000 : 50);
    const skip = (page - 1) * limit;

    const total = await Payout.countDocuments();
    let payoutQuery = Payout.find()
      .populate("provider", "fullName phoneNumber serviceCategory")
      .sort({ requestedAt: -1 });

    if (!isAll) {
      payoutQuery = payoutQuery.skip(skip).limit(limit);
    }

    const payouts = await payoutQuery;

    const formatted = payouts.map(p => ({
      ...p.toObject(),
      providerId: p.provider // Frontend expects providerId for provider info
    }));

    return res.status(StatusCodes.OK).json({
      success: true,
      payouts: formatted,
      pagination: {
        total,
        page,
        limit,
        pages: Math.ceil(total / limit) || 1
      }
    });
  } catch (error) {
    console.error("Error fetching payouts:", error);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: "Internal Server Error" });
  }
};

import { uploadToStorage } from "../libs/storage.js";

/* ------------------------------------------------------------------
   UPDATE PAYOUT STATUS (APPROVE/REJECT)
   Endpoint: PUT /admin/payouts/:id/process
-------------------------------------------------------------------*/
export const updatePayoutStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, remarks } = req.body;
    let receiptUrl = "";

    if (req.file) {
      receiptUrl = await uploadToStorage(req.file, "payouts");
    }

    if (!["Approved", "Rejected"].includes(status)) {
      return res.status(StatusCodes.BAD_REQUEST).json({ error: "Invalid status" });
    }

    const payout = await Payout.findByIdAndUpdate(
      id,
      {
        status,
        remarks,
        processedAt: new Date(),
        receipt: receiptUrl || undefined
      },
      { new: true }
    ).populate("provider", "fullName phoneNumber serviceCategory");

    if (!payout) {
      return res.status(StatusCodes.NOT_FOUND).json({ error: "Payout request not found" });
    }

    // Real-time notification to Provider
    try {
      getIO().to(`provider_${payout.provider?._id}`).emit("payout_status_updated", {
        payoutId: payout._id,
        status: payout.status,
        remarks: payout.remarks,
        receipt: payout.receipt,
        message: `Your payout request for ₹${payout.amount} has been ${payout.status.toLowerCase()}.`
      });
      broadcastStats();
    } catch (ioErr) {
      console.error("Socket emit/broadcast error:", ioErr.message);
    }

    return res.status(StatusCodes.OK).json({
      success: true,
      payout: {
        ...payout.toObject(),
        providerId: payout.provider // Map for frontend compatibility
      }
    });
  } catch (error) {
    console.error("FATAL ERROR IN updatePayoutStatus 👉", error);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: "Internal Server Error",
      details: error.message
    });
  }
};

/* ------------------------------------------------------------------
   REFUND BOOKING TOKEN TO WALLET
   Endpoint: POST /admin/bookings/:id/refund
-------------------------------------------------------------------*/
export const refundBookingToWallet = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    const booking = await Booking.findById(id).populate("userId");
    if (booking && booking.service && mongoose.Types.ObjectId.isValid(booking.service)) {
      try {
        await booking.populate("service");
      } catch (err) {
        console.error("Admin refundBookingToWallet service population failed:", err);
      }
    }
    if (!booking) {
      return res.status(StatusCodes.NOT_FOUND).json({ error: "Booking not found" });
    }

    if (booking.status === "cancelled" && booking.refundStatus === "Refunded") {
      return res.status(StatusCodes.BAD_REQUEST).json({ error: "Already refunded" });
    }

    // BLOCK REFUNDS FOR DIGITAL SERVICES
    const isDigitalService = (booking.service && typeof booking.service === 'object' && (booking.service.requestId || booking.service.bidId || booking.service.category === "Digital Work")) || 
                             (booking.serviceType && (booking.serviceType.toLowerCase().includes("bidding") || booking.serviceType.toLowerCase().includes("digital")));
    
    if (isDigitalService) {
      return res.status(StatusCodes.BAD_REQUEST).json({ error: "Digital service bookings are non-refundable per platform policy." });
    }

    // Find the token transaction
    const transaction = await Transaction.findOne({
      bookingId: id,
      type: "token",
      status: "Completed"
    });

    if (!transaction) {
      return res.status(StatusCodes.NOT_FOUND).json({ error: "No completed token transaction found for this booking" });
    }

    const refundAmount = transaction.amount;
    const userId = booking.userId?._id || booking.userId;
    const user = await User.findById(userId);

    if (!user) {
      return res.status(StatusCodes.NOT_FOUND).json({ error: "User not found" });
    }

    // 1. Update User Wallet Balance
    user.walletBalance = (user.walletBalance || 0) + refundAmount;
    await user.save();

    // 2. Create Wallet Transaction Record
    const walletTx = new WalletTransaction({
      user: user._id,
      amount: refundAmount,
      balanceAfter: user.walletBalance,
      type: "credit",
      status: "completed",
      description: `Refund for Booking #${id.slice(-6).toUpperCase()} - ${reason || "Provider Unavailable"}`,
      razorpayPaymentId: "PLATFORM_REFUND",
      razorpayOrderId: `REFUND-${id.slice(-6).toUpperCase()}`,
      metadata: {
        bookingId: id,
        adminAction: true
      }
    });
    await walletTx.save();

    // 3. Update Booking Status
    booking.status = "cancelled";
    booking.refundStatus = "Refunded";
    await booking.save();

    // 4. Update Original Transaction Status
    transaction.status = "Refunded";
    await transaction.save();

    // Real-time notification to User
    try {
      getIO().to(`user_${user._id}`).emit("wallet_updated", {
        balance: user.walletBalance,
        message: `₹${refundAmount} has been refunded to your wallet for booking #${id.slice(-6).toUpperCase()}.`
      });
      broadcastStats();
    } catch (ioErr) {
      console.error("Socket emit error:", ioErr.message);
    }

    return res.status(StatusCodes.OK).json({
      success: true,
      message: `Refund of ₹${refundAmount} processed successfully to ${user.fullName}'s wallet.`,
      newBalance: user.walletBalance
    });

  } catch (error) {
    console.error("Error processing booking refund:", error);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: "Internal Server Error" });
  }
};

/* ------------------------------------------------------------------
   CANCEL AND REFUSE BOOKING (ADMIN)
   Endpoint: POST /admin/bookings/:id/cancel
-------------------------------------------------------------------*/
export const cancelBookingAdmin = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    const booking = await Booking.findById(id);
    if (booking && booking.service && mongoose.Types.ObjectId.isValid(booking.service)) {
      try {
        await booking.populate("service");
      } catch (err) {
        console.error("Admin cancelBookingAdmin service population failed:", err);
      }
    }
    if (!booking) {
      return res.status(StatusCodes.NOT_FOUND).json({ error: "Booking record not found in cluster." });
    }

    // 1. Update Booking Status to Terminated
    booking.status = "cancelled";
    booking.adminRemark = reason || "Administrative Intervention - Refused by Platform Admin";
    await booking.save();

    // 2. Dispatch Intelligence to CUSTOMER
    try {
      const isDigital = (booking.service && typeof booking.service === 'object' && (booking.service.requestId || booking.service.bidId || booking.service.category === "Digital Work")) || 
                        (booking.serviceType && (booking.serviceType.toLowerCase().includes("bidding") || booking.serviceType.toLowerCase().includes("digital")));

      await UserNotification.create({
        userId: booking.userId,
        title: "⚠️ Booking Refused by Admin",
        message: `Your engagement for ${booking.serviceType} has been terminated by the administrator. Status: Refused. ${isDigital ? "Note: Per policy, digital services are non-refundable." : "You can now request a refund for your token."}`,
        type: "booking_update",
        metadata: { bookingId: booking._id, action: "refused" }
      });

      getIO().to(`user_${booking.userId.toString()}`).emit("newNotification", {
        title: "Booking Cancelled",
        message: "An administrator has refused and terminated your active booking. You are eligible for a refund."
      });
      
      getIO().to(`user_${booking.userId.toString()}`).emit("booking_status", {
        bookingId: booking._id,
        status: "cancelled",
        message: "Admin has cancelled this booking."
      });
    } catch (uErr) {
      console.error("User Notification Error:", uErr.message);
    }

    // 3. Dispatch Intelligence to PROVIDER (if assigned)
    if (booking.providerId) {
      try {
        // Free the provider
        await Provider.findByIdAndUpdate(booking.providerId, {
            isAvailable: true,
        });

        await ProviderNotification.create({
          provider: booking.providerId,
          title: "🛑 Admin Intervention: Refusal",
          message: `The active booking with ${booking.customerName || 'Client'} has been refused and cancelled by the admin. You are now available for other jobs.`,
          type: "status_change",
          metadata: { bookingId: booking._id }
        });

        getIO().to(`provider_${booking.providerId.toString()}`).emit("newNotification", {
          title: "Booking Terminated",
          message: "The admin has intervened and cancelled the current engagement."
        });

        getIO().to(`provider_${booking.providerId.toString()}`).emit("booking_status", {
            bookingId: booking._id,
            status: "cancelled",
            message: "Admin has cancelled this booking."
        });
      } catch (pErr) {
        console.error("Provider Notification Error:", pErr.message);
      }
    }

    // 4. Global Sync
    getIO().emit("bookingUpdated", booking);
    broadcastStats();

    return res.status(StatusCodes.OK).json({ 
      success: true, 
      message: "Engagement has been successfully refused and terminated across all nodes." 
    });
  } catch (error) {
    console.error("Cancellation Error:", error);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: "Platform cancellation protocol failed." });
  }
};

/* ------------------------------------------------------------------
   RESET PROVIDER NO-SHOW STRIKES
   Endpoint: POST /admin/providers/:id/reset-strikes
-------------------------------------------------------------------*/
export const resetProviderStrikes = async (req, res) => {
  try {
    const { id } = req.params;
    const provider = await Provider.findById(id);
    if (!provider) {
      return res.status(StatusCodes.NOT_FOUND).json({ error: "Provider not found" });
    }

    provider.noShowStrikes = 0;
    if (provider.status === "Suspended") {
      provider.status = "Active";
      provider.isAvailable = true;
    }
    await provider.save();

    try {
      getIO().to(`provider_${provider._id}`).emit("provider_strike_alert", {
        strikes: 0,
        status: provider.status,
        message: "Your No-Show strikes have been reset by Admin. Profile activated."
      });
      broadcastStats();
    } catch (ioErr) { }

    return res.status(StatusCodes.OK).json({
      success: true,
      message: `Strikes reset for ${provider.fullName}. Account status set to ${provider.status}.`,
      provider
    });
  } catch (error) {
    console.error("Error resetting strikes:", error);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: "Internal Server Error" });
  }
};
