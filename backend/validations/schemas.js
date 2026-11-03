import Joi from "joi";


/**
 * Customer Requirement
 */
export const registerSchema = Joi.object({
  fullName: Joi.string().trim().min(2).max(100).pattern(/^[a-zA-Z\s]+$/).message('Full Name must contain only letters and spaces.').required(),
  email: Joi.string().trim().email().required(),
  phoneNumber: Joi.string()
    .trim()
    .pattern(/^\+?[1-9]\d{7,14}$/)
    .required(),
  password: Joi.string()
    .min(8)
    .pattern(/^(?=.*[!@#$%^&*])/)
    .message('Password must be at least 8 characters and contain at least one special symbol (!@#$%^&*)')
    .required(),
});

export const loginSchema = Joi.object({
  phoneNumber: Joi.string()
    .trim()
    .pattern(/^\+?[1-9]\d{7,14}$/)
    .required(),
  password: Joi.string().required(),
});

export const verifySchema = Joi.object({
  phoneNumber: Joi.string()
    .trim()
    .pattern(/^\+?[1-9]\d{7,14}$/) 
    .required(),
  otp: Joi.string()
    .trim()
    .length(4)
    .pattern(/^\d{4}$/)
    .required(),
});

export const addressSchema = Joi.object({
   address: Joi.string().trim().min(5).max(255).required(), 
   city: Joi.string().trim().min(2).max(100).required(), 
   state: Joi.string().trim().min(2).max(100).required(), 
  });


// Provider validation schemas
export const providerRegisterSchema = Joi.object({
  providerType: Joi.string().valid("individual", "business").default("individual").optional(),
  fullName: Joi.string().trim().min(2).max(100).pattern(/^[a-zA-Z\s]+$/).message('Full Name must contain only letters and spaces.').required(),
  email: Joi.string().trim().email().required(),
  phoneNumber: Joi.string()
    .trim()
    .pattern(/^\+?[1-9]\d{7,14}$/) // E.164 format
    .required(),
  password: Joi.string()
    .min(8)
    .pattern(/^(?=.*[!@#$%^&*])/)
    .message('Password must be at least 8 characters and contain at least one special symbol (!@#$%^&*)')
    .required(),
  businessName: Joi.string().trim().allow("").optional(),
});

export const businessDetailsSchema = Joi.object({
  businessName: Joi.string().trim().min(2).max(120).required(),
  registrationNumber: Joi.string().trim().allow("").optional(),
  gstNumber: Joi.string().trim().allow("").optional(),
  establishedYear: Joi.number().integer().min(1900).max(new Date().getFullYear() + 1).allow(null).optional(),
  description: Joi.string().trim().allow("").optional(),
  website: Joi.string().trim().allow("").optional(),
});

export const workerSchema = Joi.object({
  name: Joi.string().trim().min(2).max(80).required(),
  phoneNumber: Joi.string().trim().pattern(/^\+?[1-9]\d{7,14}$/).allow("").optional(),
  role: Joi.string().trim().max(80).allow("").optional(),
  photo: Joi.string().allow("").optional(),
  idProof: Joi.string().allow("").optional(),
});

export const providerForgotPasswordSchema = Joi.object({
  email: Joi.string().trim().email().required(),
});

export const providerResetPasswordSchema = Joi.object({
  email: Joi.string().trim().email().required(),
  otp: Joi.string()
    .trim()
    .length(4)
    .pattern(/^\d{4}$/)
    .required(),
  newPassword: Joi.string()
    .min(8)
    .pattern(/^(?=.*[!@#$%^&*])/)
    .message('Password must be at least 8 characters and contain at least one special symbol (!@#$%^&*)')
    .required(),
});

export const providerLoginSchema = Joi.object({
  phoneNumber: Joi.string()
    .trim()
    .pattern(/^\+?[1-9]\d{7,14}$/) // E.164 format
    .required(),
  password: Joi.string().required(),
});

export const providerVerifySchema = Joi.object({
  phoneNumber: Joi.string()
    .trim()
    .pattern(/^\+?[1-9]\d{7,14}$/) // E.164 format
    .required(),
  otp: Joi.string()
    .trim()
    .length(4) // must match generateOTP()
    .pattern(/^\d{4}$/)
    .required(),
});


export const serviceSchema = Joi.object({
  serviceCategory: Joi.string().required(),
  providerSubService: Joi.string().allow("").optional(),
  subService: Joi.array().items(Joi.string()).min(1).max(4).single().required(),
  experience: Joi.number().min(0).max(80).required(),
  languageSpoken: Joi.string().trim().min(2).max(100).pattern(/^[a-zA-Z\s,]+$/).message('Languages Spoken must contain only letters, spaces, and commas (e.g. Hindi, English).').required(),
  houseNumber: Joi.string().required(),
  colony: Joi.string().required(),
  landmark: Joi.string().required(),
  city: Joi.string().required(),
  state: Joi.string().required(),
  pinCode: Joi.string().pattern(/^\d{6}$/).required(),
  latitude: Joi.number().allow(null),
  longitude: Joi.number().allow(null),
});


export const bankSchema = Joi.object({
  accountHolderName: Joi.string().trim().pattern(/^[a-zA-Z\s]{2,60}$/).message('Account Holder Name must contain only letters and spaces.').required(),
  bankAccountNumber: Joi.string().trim().pattern(/^\d{8,18}$/).message('Bank Account Number must be between 8 and 18 digits.').required(),
  ifscCode: Joi.string().trim().pattern(/^[A-Z]{4}0[A-Z0-9]{6}$/i).message('Invalid IFSC Code format.').required(),
  upiId: Joi.string().allow(""),
});


export const providerUpdateSchema = Joi.object({
  fullName:Joi.string().trim().min(2).max(100).pattern(/^[a-zA-Z\s]+$/).message('Full Name must contain only letters and spaces.'),
  serviceCategory:Joi.string().trim().max(100),
  providerSubService: Joi.string().trim().max(100),
  experience:Joi.number().max(50),
  languageSpoken:Joi.string().trim().max(100).pattern(/^[a-zA-Z\s,]+$/).message('Languages Spoken must contain only letters, spaces, and commas.'),
  houseNo:Joi.string().trim().max(80),
  colony:Joi.string().trim().max(100),
  city:Joi.string().trim().max(100),
  state:Joi.string().trim().max(50),
  pinCode: Joi.string().pattern(/^\d{6}$/),
  profilePhoto:Joi.string().uri(),
  governmentIDProof:Joi.string().uri(),
  addressProof:Joi.string().uri(),
  skillCertificate:Joi.string().uri(),
  // bankHolderName:Joi.string().trim().max(20),
  bankAccountNumber:Joi.string().trim().pattern(/^\d{8,18}$/).message('Bank Account Number must be between 8 and 18 digits.'),
  ifscCode:Joi.string().trim().pattern(/^[A-Z]{4}0[A-Z0-9]{6}$/i).message('Invalid IFSC Code format.'),
  upiId:Joi.string().trim().max(100),
  confirmVerification:Joi.boolean(),
}).min(1);

export const bookingCreateSchema = Joi.object({
  service: Joi.string().required(),
  serviceType: Joi.string().required(),
  date: Joi.date().iso().required(),
  time: Joi.string().pattern(/^([01]\d|2[0-3]):?([0-5]\d)$/).required(),
  address: Joi.string().trim().min(5).max(500).required(),
  city: Joi.string().trim().required(),
  state: Joi.string().trim().required(),
  remarks: Joi.string().trim().max(500).allow(""),
  price: Joi.number().min(0).required(),
  latitude: Joi.number().required(),
  longitude: Joi.number().required(),
  addOns: Joi.array().items(Joi.object({
    serviceId: Joi.string().required(),
    name: Joi.string().required(),
    price: Joi.number().min(0).required(),
  })).default([]),
  houseNo: Joi.string().trim().max(100).allow("").optional(),
  flatNo: Joi.string().trim().max(100).allow("").optional(),
  landMark: Joi.string().trim().max(200).allow("").optional(),
  colony: Joi.string().trim().max(200).allow("").optional(),
  emergencyFee: Joi.number().min(0).optional(),
});

export const forgotPasswordSchema = Joi.object({
  email: Joi.string().trim().email().required(),
});

export const resetPasswordSchema = Joi.object({
  email: Joi.string().trim().email().required(),
  otp: Joi.string()
    .trim()
    .length(4)
    .pattern(/^\d{4}$/)
    .required(),
  newPassword: Joi.string()
    .min(8)
    .pattern(/^(?=.*[!@#$%^&*])/)
    .message('Password must be at least 8 characters and contain at least one special symbol (!@#$%^&*)')
    .required(),
});  