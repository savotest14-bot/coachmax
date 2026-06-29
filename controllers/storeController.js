const Product = require("../models/Product");
const ProductCategory = require("../models/ProductCategory");
const Cart = require("../models/Cart");
const Order = require("../models/Order");
const Invoice = require("../models/Invoice");
const mongoose = require("mongoose");

// ✅ ProductCategory Create (Admin only)
exports.createCategory = async (req, res) => {
  try {
    const { name, description } = req.body;
    if (!name) {
      return res.status(400).json({ success: false, message: "name is required" });
    }

    const category = await ProductCategory.create({ name, description });
    res.status(201).json({ success: true, message: "Product category created", data: category });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ✅ Product Create (Admin only)
exports.createProduct = async (req, res) => {
  try {
    const { name, description, category, price, stock, sizes, colors } = req.body;

    if (!name || !category || price === undefined || stock === undefined) {
      return res.status(400).json({ success: false, message: "Required fields missing" });
    }

    let images = [];
    if (req.files) {
      images = req.files.map((file) => `uploads/products/${file.filename}`);
    } else if (req.file) {
      images = [`uploads/products/${req.file.filename}`];
    }

    const product = await Product.create({
      name,
      description,
      images,
      category,
      price,
      stock,
      sizes: sizes ? (Array.isArray(sizes) ? sizes : [sizes]) : [],
      colors: colors ? (Array.isArray(colors) ? colors : [colors]) : [],
    });

    res.status(201).json({ success: true, message: "Product created successfully", data: product });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ✅ Get Products List
exports.getProducts = async (req, res) => {
  try {
    const { categoryId, search } = req.query;
    const query = { status: "ACTIVE" };

    if (categoryId) query.category = categoryId;
    if (search) {
      query.$or = [
        { name: { $regex: search, $options: "i" } },
        { description: { $regex: search, $options: "i" } },
      ];
    }

    const products = await Product.find(query).populate("category", "name");
    res.json({ success: true, data: products });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ✅ Add item to Cart (Parent only)
exports.addToCart = async (req, res) => {
  try {
    const { productId, quantity, selectedSize, selectedColor } = req.body;
    const parentId = req.parent._id;

    if (!productId || !quantity) {
      return res.status(400).json({ success: false, message: "productId and quantity are required" });
    }

    // Verify stock
    const product = await Product.findById(productId);
    if (!product || product.status !== "ACTIVE") {
      return res.status(404).json({ success: false, message: "Product not found" });
    }

    if (product.stock < quantity) {
      return res.status(400).json({ success: false, message: "Insufficient product stock" });
    }

    let cart = await Cart.findOne({ parent: parentId });
    if (!cart) {
      cart = new Cart({ parent: parentId, items: [] });
    }

    const existingIndex = cart.items.findIndex(
      (item) =>
        item.product.toString() === productId &&
        item.selectedSize === (selectedSize || "") &&
        item.selectedColor === (selectedColor || "")
    );

    if (existingIndex > -1) {
      cart.items[existingIndex].quantity += Number(quantity);
    } else {
      cart.items.push({
        product: productId,
        quantity,
        selectedSize: selectedSize || "",
        selectedColor: selectedColor || "",
      });
    }

    await cart.save();
    res.json({ success: true, message: "Product added to cart", data: cart });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ✅ Get Parent's Cart
exports.getCart = async (req, res) => {
  try {
    const parentId = req.parent._id;
    let cart = await Cart.findOne({ parent: parentId }).populate("items.product", "name price images stock status");
    if (!cart) {
      cart = await Cart.create({ parent: parentId, items: [] });
    }

    res.json({ success: true, data: cart });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ✅ Checkout Order (Parent only)
exports.checkout = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const parentId = req.parent._id;
    const { shippingAddress } = req.body;

    if (!shippingAddress) {
      return res.status(400).json({ success: false, message: "shippingAddress is required" });
    }

    const cart = await Cart.findOne({ parent: parentId }).populate("items.product");
    if (!cart || cart.items.length === 0) {
      return res.status(400).json({ success: false, message: "Your shopping cart is empty" });
    }

    let totalAmount = 0;
    const orderItems = [];

    // Verify stock and calculate total
    for (const item of cart.items) {
      const dbProduct = item.product;

      if (!dbProduct || dbProduct.status !== "ACTIVE") {
        return res.status(400).json({ success: false, message: `Product ${dbProduct?.name || ""} is inactive` });
      }

      if (dbProduct.stock < item.quantity) {
        return res.status(400).json({ success: false, message: `Insufficient stock for product: ${dbProduct.name}` });
      }

      // Decrement stock
      dbProduct.stock -= item.quantity;
      await dbProduct.save({ session });

      totalAmount += dbProduct.price * item.quantity;
      orderItems.push({
        product: dbProduct._id,
        quantity: item.quantity,
        price: dbProduct.price,
        selectedSize: item.selectedSize,
        selectedColor: item.selectedColor,
      });
    }

    // Create Invoice
    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() + 7); // Due in 7 days
    const invoice = await Invoice.create(
      [
        {
          parent: parentId,
          amount: totalAmount,
          dueDate,
          type: "STORE_ORDER",
          description: `Order checkout for items: ${cart.items.map((i) => i.product.name).join(", ")}`,
          status: "PENDING",
        },
      ],
      { session }
    );

    // Create Order
    const order = await Order.create(
      [
        {
          parent: parentId,
          items: orderItems,
          totalAmount,
          paymentStatus: "PENDING",
          shippingAddress,
          status: "PENDING",
          invoice: invoice[0]._id,
        },
      ],
      { session }
    );

    // Clear Cart
    cart.items = [];
    await cart.save({ session });

    await session.commitTransaction();
    session.endSession();

    res.status(201).json({
      success: true,
      message: "Order placed successfully. Invoice generated.",
      data: {
        order: order[0],
        invoice: invoice[0],
      },
    });
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    res.status(500).json({ success: false, message: err.message });
  }
};
