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

exports.getAllCategories = async (req, res) => {
  try {
    const { search = "" } = req.query;

    const filter = {};

    if (search) {
      filter.name = {
        $regex: search,
        $options: "i",
      };
    }

    const categories = await ProductCategory.find(filter)
      .sort({ createdAt: -1 });

    res.status(200).json({
      success: true,
      count: categories.length,
      data: categories,
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

exports.updateCategory = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description } = req.body;

    const category = await ProductCategory.findById(id);

    if (!category) {
      return res.status(404).json({
        success: false,
        message: "Category not found",
      });
    }

    if (name) category.name = name;
    if (description !== undefined) category.description = description;

    await category.save();

    res.status(200).json({
      success: true,
      message: "Category updated successfully",
      data: category,
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

exports.deleteCategory = async (req, res) => {
  try {
    const { id } = req.params;

    const category = await ProductCategory.findById(id);

    if (!category) {
      return res.status(404).json({
        success: false,
        message: "Category not found",
      });
    }

    const productExists = await Product.exists({
      category: id,
    });

    if (productExists) {
      return res.status(400).json({
        success: false,
        message: "Category cannot be deleted because it is assigned to one or more products.",
      });
    }

    await ProductCategory.findByIdAndDelete(id);

    res.status(200).json({
      success: true,
      message: "Category deleted successfully",
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

// ✅ Product Create (Admin only)
exports.createProduct = async (req, res) => {
  try {
    const {
      name,
      shortHighlight,
      description,
      category,
      price,
      stock,
      sizes,
      colors,
      availabilityStatus,
    } = req.body;

    if (!name || !category || !price) {
      return res.status(400).json({
        success: false,
        message: "Product name, category and price are required.",
      });
    }

    let images = [];

    if (req.files && req.files.length > 0) {
      images = req.files.map(
        (file) => `uploads/products/${file.filename}`
      );
    }

    const product = await Product.create({
      name,
      shortHighlight,
      description,
      category,
      price: Number(price),
      stock: Number(stock || 0),
      availabilityStatus:
        availabilityStatus || "IN_STOCK",
      images,
      sizes: sizes
        ? Array.isArray(sizes)
          ? sizes
          : JSON.parse(sizes)
        : [],
      colors: colors
        ? Array.isArray(colors)
          ? colors
          : JSON.parse(colors)
        : [],
    });

    return res.status(201).json({
      success: true,
      message: "Product created successfully.",
      data: product,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

// ✅ Get Products List
exports.getProducts = async (req, res) => {
  try {
    const {
      categoryId,
      search,
      page = 1,
      limit = 10,
    } = req.query;

    const query = {
      status: "ACTIVE",
    };

    if (categoryId) {
      query.category = categoryId;
    }

    if (search) {
      query.$or = [
        {
          name: {
            $regex: search,
            $options: "i",
          },
        },
        {
          description: {
            $regex: search,
            $options: "i",
          },
        },
      ];
    }

    const currentPage = Number(page);
    const pageLimit = Number(limit);
    const skip = (currentPage - 1) * pageLimit;

    const [products, total] = await Promise.all([
      Product.find(query)
        .populate("category", "name")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(pageLimit),
      Product.countDocuments(query),
    ]);

    return res.status(200).json({
      success: true,
      data: products,
      pagination: {
        page: currentPage,
        limit: pageLimit,
        total,
        hasMore: skip + products.length < total,
        nextPage:
          skip + products.length < total
            ? currentPage + 1
            : null,
      },
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message,
    });
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
