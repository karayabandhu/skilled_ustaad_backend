import mongoose from "mongoose";
import { encryptBankDetail, decryptBankDetail } from "../utils/encryption.js";

const providerSchema = new mongoose.Schema(
  {
    /* Provider Persona: individual vs business / shop owner */
    providerType: {
      type: String,
      enum: ["individual", "business"],
      default: "individual",
      index: true
    },

    /* Business / Shop Owner Details (Optional for individual) */
    businessDetails: {
      businessName: { type: String, trim: true, default: "" },
      registrationNumber: { type: String, trim: true, default: "" },
      gstNumber: { type: String, trim: true, default: "" },
      establishedYear: { type: Number, default: null },
      description: { type: String, trim: true, default: "" },
      shopPhotos: [{ type: String }],
      website: { type: String, trim: true, default: "" }
    },

    /* Workers / Technicians (Optional for Business) */
    workers: [
      {
        name: { type: String, trim: true, required: true },
        phoneNumber: { type: String, trim: true, default: "" },
        role: { type: String, trim: true, default: "" },
        photo: { type: String, default: "" },
        idProof: { type: String, default: "" },
        isActive: { type: Boolean, default: true },
        createdAt: { type: Date, default: Date.now }
      }
    ],

    /*Step 1 */
    fullName: { 
      type: String, 
      required: true, 
      trim: true 
    },
    email: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true
    },
    phoneNumber: { 
      type: String, 
      required: true, 
      unique: true, 
      trim: true 
    },
    password: {
      type: String,
      required: true,
      select: false
    },
    isVerified: {
      type: Boolean,
      default: false,
    },

    /*Step-2 (Removed OTP) */

    /*Step -3 */
    serviceCategory: { 
      type: String, 
      trim: true, 
      default: "" 
    },
    providerSubService: { 
      type: String, 
      trim: true, 
      default: "" 
    },
    subService: { 
      type: [String], 
      default: []
    },
    experience: { 
      type: Number, 
      default: 0 
    },
    // serviceArea: { type: String, trim: true, default: "" },
    address:{
        houseNumber:{
          type: String,
          trim:true,
        },
        companyName:{
          type:String,
          trim:true,
        },
        colony:{
          type:String,
          trim:true,
        },
        landmark:{
          type:String,
          trim:true,
        },
    },
    city:{
       type: String,
       trim:true,
    },
    state:{
      type: String,
      trim:true,
    },
    pinCode: { 
      type: String, 
      trim: true 
    },
    languageSpoken: { 
      type: String, 
      trim: true 
    },

    /*Geo Location*/
    
    location:{
      type:{
        type:String,
        enum:["Point"],
      },
      coordinates:{
        type:[Number], // [longitude, latitude]
      }
    },

    /*Step-4 */
    profilePhoto: { 
      type: String,
      default:"",  
    },
    governmentIDProof: { 
      type: String,
      default:"",  
    },
    addressProof: { 
      type: String,
      default:"",  
    },
    skillCertificate: { 
      type: String, 
      default: "" 
    },
    businessRegistrationProof: { 
      type: String, 
      default: "" 
    },
    tradeLicense: { 
      type: String, 
      default: "" 
    },
    shopFrontPhoto: { 
      type: String, 
      default: "" 
    },


    /*Step-5 */
    bankAccountNumber: { 
      type: String, 
      trim: true,
      default: "",
      get: decryptBankDetail,
      set: encryptBankDetail
    },
    ifscCode: { 
      type: String, 
      trim: true ,
      default: "",
      get: decryptBankDetail,
      set: encryptBankDetail
    },
    upiId: { 
      type: String, 
      trim: true,
      default: "",
      get: decryptBankDetail,
      set: encryptBankDetail
    },
    accountHolderName:{
      type:String,
      trim:true,
      default:"",
    },

    backgroundVerification: { type: String, default: "Pending" },
    // Status: Pending (new) → Active (accepted) or Suspended (blocked)
    status: { 
      type: String, 
      enum: ["Pending", "Active", "Suspended", "Terminated"], 
      default: "Pending" 
    },
    isRegistrationComplete: {
      type: Boolean,
      default: false
    },
    /* Application Lifecycle State Machine */
    applicationStatus: {
      type: String,
      enum: ["draft", "under_review", "changes_needed", "approved", "rejected"],
      default: "draft",
      index: true
    },
    adminReviewNotes: {
      type: String,
      default: ""
    },
    changesRequestedFields: [{
      type: String
    }],
    reviewedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Admin"
    },
    reviewedAt: {
      type: Date
    },
    currentStep: {
      type: Number,
      default: 1
    },
    jobs: { 
      type: Number, 
      default: 0 
    },
    rating: { 
      type: Number, 
      default: 0 
    },
    refreshToken: {
      type: [String],
      select: false,
      index: true,
      default: [],
    },

   isAvailable:{
    type:Boolean,
    default:true
   },
   noShowStrikes: {
     type: Number,
     default: 0
   },
   strikeHistory: [
     {
       bookingId: { type: mongoose.Schema.Types.ObjectId, ref: "Booking" },
       reason: String,
       createdAt: { type: Date, default: Date.now }
     }
   ],
   deviceToken:{
     type:String,
     default:null
   },
   otpHash: { type: String, select: false },
   otpExpires: { type: Date, select: false },

    /*Delete Account OTP*/
    deleteOtpHash:{
      type: String,
    },
    deleteOtpExpires: Date,
    lastDeleteOtpAt: Date,

    /* Notification Preferences */
    notificationPreferences: {
      booking_request: { type: Boolean, default: true },
      booking_accepted: { type: Boolean, default: true },
      payment_received: { type: Boolean, default: true },
      profile_verification: { type: Boolean, default: true },
      customer_rating: { type: Boolean, default: true },
      job_reminder: { type: Boolean, default: true },
      payment_pending: { type: Boolean, default: true },
      feature_update: { type: Boolean, default: true },
    },
    notificationSound: {
      type: String,
      default: "default", // Options: "default", "alert", "chime", "subtle"
    },
    /* Subscription Status & Details */
    subscription: {
      planId: { type: String, default: null },
      planName: { type: String, default: null },
      startDate: { type: Date, default: null },
      expiryDate: { type: Date, default: null },
      status: {
        type: String,
        enum: ["inactive", "active", "expired"],
        default: "inactive",
      },
      transactionId: { type: String, default: null },
      razorpayOrderId: { type: String, default: null },
    },
  },
  { 
    timestamps: true,
    toJSON: { getters: true },
    toObject: { getters: true }
  }
);

// create sparse unique index for email (ignore missing)

providerSchema.index({ city: 1 });
providerSchema.index({ status: 1 });
providerSchema.index({ applicationStatus: 1 });
providerSchema.index({ providerType: 1 });
providerSchema.index({ deviceToken: 1 }, { sparse: true }); // Performance boost for notifications
providerSchema.index({ location: "2dsphere" });

// Real-time updates should be triggered explicitly for performance

import bcrypt from "bcryptjs";

// ... (schema definition remains)

providerSchema.pre("save", async function (next) {
  if (!this.isModified("password")) return next();
  try {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (err) {
    next(err);
  }
});

providerSchema.methods.comparePassword = async function (candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

const Provider = mongoose.models.Provider || mongoose.model("Provider", providerSchema);
export default Provider;

