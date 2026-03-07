const mongoose = require("mongoose");

const redeemSchema = new mongoose.Schema({
    code: {
        type: String,
        unique: true,
        required: true
    },
    coins: {
        type: Number,
        default: 100
    },
    used: {
        type: Boolean,
        default: false
    },
    usedBy: {
        type: String,
        default: null
    },
    createdAt: {
        type: Date,
        default: Date.now
    }
});

module.exports = mongoose.model("RedeemCode", redeemSchema);
