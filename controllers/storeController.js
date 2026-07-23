const Product = require("../models/Product");
const ProductCategory = require("../models/ProductCategory");
const Cart = require("../models/Cart");
const Order = require("../models/Order");
const Invoice = require("../models/Invoice");
const Parent = require("../models/Parent");
const mongoose = require("mongoose");
const { sendNotification } = require("../services/notificationService");

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
        (file) => `uploads/images/${file.filename}`
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
    const { productId, quantity, selectedSize = "", selectedColor = "" } = req.body;
    const parentId = req.parent._id;

    if (!productId || quantity === undefined) {
      return res.status(400).json({
        success: false,
        message: "productId and quantity are required",
      });
    }

    if (quantity < 0) {
      return res.status(400).json({
        success: false,
        message: "Quantity cannot be negative",
      });
    }

    // Verify product
    const product = await Product.findById(productId);
    if (!product || product.status !== "ACTIVE") {
      return res.status(404).json({
        success: false,
        message: "Product not found",
      });
    }

    // Check stock
    if (quantity > product.stock) {
      return res.status(400).json({
        success: false,
        message: `Only ${product.stock} items available in stock.`,
      });
    }

    let cart = await Cart.findOne({ parent: parentId });

    if (!cart) {
      cart = new Cart({
        parent: parentId,
        items: [],
      });
    }

    const itemIndex = cart.items.findIndex(
      (item) =>
        item.product.toString() === productId &&
        item.selectedSize === selectedSize &&
        item.selectedColor === selectedColor
    );

    if (itemIndex > -1) {
      if (quantity === 0) {
        // Remove item
        cart.items.splice(itemIndex, 1);
      } else {
        // Update quantity
        cart.items[itemIndex].quantity = quantity;
      }
    } else {
      if (quantity > 0) {
        cart.items.push({
          product: productId,
          quantity,
          selectedSize,
          selectedColor,
        });
      }
    }

    await cart.save();

    await cart.populate(
      "items.product",
      "name price images stock status"
    );

    return res.status(200).json({
      success: true,
      message:
        quantity === 0
          ? "Product removed from cart"
          : "Cart updated successfully",
      data: cart,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};


exports.updateCartQuantity = async (req, res) => {
  try {
    const { cartItemId, action } = req.body;
    const parentId = req.parent._id;

    const cart = await Cart.findOne({ parent: parentId });

    if (!cart) {
      return res.status(404).json({
        success: false,
        message: "Cart not found",
      });
    }

    const item = cart.items.id(cartItemId);

    if (!item) {
      return res.status(404).json({
        success: false,
        message: "Cart item not found",
      });
    }

    const product = await Product.findById(item.product);

    if (action === "increment") {
      if (item.quantity >= product.stock) {
        return res.status(400).json({
          success: false,
          message: "No more stock available",
        });
      }

      item.quantity += 1;
    }

    if (action === "decrement") {
      if (item.quantity > 1) {
        item.quantity -= 1;
      } else {
        return res.status(400).json({
          success: false,
          message: "Minimum quantity is 1. Use remove API.",
        });
      }
    }

    await cart.save();

    res.json({
      success: true,
      message: "Quantity updated successfully",
      data: cart,
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

exports.removeCartItem = async (req, res) => {
  try {
    const { cartItemId } = req.params;
    const parentId = req.parent._id;

    const cart = await Cart.findOne({ parent: parentId });

    if (!cart) {
      return res.status(404).json({
        success: false,
        message: "Cart not found",
      });
    }

    cart.items = cart.items.filter(
      (item) => item._id.toString() !== cartItemId
    );

    await cart.save();

    res.json({
      success: true,
      message: "Product removed from cart",
      data: cart,
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

// ✅ Get Parent's Cart
exports.getCart = async (req, res) => {
  try {
    const parentId = req.parent._id;

    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.max(parseInt(req.query.limit) || 10, 1);
    const skip = (page - 1) * limit;

    let cart = await Cart.findOne({ parent: parentId })
      .populate("items.product", "name price images stock status");

    if (!cart) {
      cart = await Cart.create({
        parent: parentId,
        items: [],
      });
    }

    const totalItems = cart.items.length;

    const paginatedItems = cart.items.slice(skip, skip + limit);

    res.json({
      success: true,
      data: {
        _id: cart._id,
        parent: cart.parent,
        items: paginatedItems,
        createdAt: cart.createdAt,
        updatedAt: cart.updatedAt,
      },
      pagination: {
        page,
        limit,
        totalItems,
        totalPages: Math.ceil(totalItems / limit),
        hasNextPage: page < Math.ceil(totalItems / limit),
        hasPrevPage: page > 1,
      },
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: err.message,
    });
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
    const year = new Date().getFullYear();
    const invoiceNumber = `INV-${year}-${Date.now().toString().slice(-6)}`;
    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() + 7); // Due in 7 days

    const invoiceItems = cart.items.map((i) => ({
      title: i.product?.name || "Store Item",
      description: `Size: ${i.selectedSize || "N/A"}, Color: ${i.selectedColor || "N/A"}, Qty: ${i.quantity}`,
      amount: (i.product?.price || 0) * i.quantity,
    }));

    const invoice = await Invoice.create(
      [
        {
          invoiceNumber,
          parent: parentId,
          items: invoiceItems,
          subtotal: totalAmount,
          totalAmount,
          amount: totalAmount,
          dueDate,
          type: "STORE_ORDER",
          description: `Order checkout for ${cart.items.length} item(s)`,
          paymentStatus: "UNPAID",
          status: "ACTIVE",
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

    // Send Admin Notification & Push Notification for new store order
    try {
      const parentDoc = await Parent.findById(parentId).select("fullName");
      const parentName = parentDoc ? parentDoc.fullName : "Parent";

      await sendNotification({
        recipientType: "ADMIN",
        adminId: null,
        title: "New Store Order Placed 🛒",
        message: `${parentName} placed a store order of $${totalAmount} (${orderItems.length} item(s)). Invoice #${invoiceNumber}.`,
        type: "ANNOUNCEMENT",
        data: {
          orderId: String(order[0]._id),
          invoiceId: String(invoice[0]._id),
          parentId: String(parentId),
        },
      });
    } catch (notifErr) {
      console.error("Admin checkout notification error:", notifErr.message);
    }

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

// ✅ Get All Orders (Admin only with invoice number & other details)
exports.getAllOrders = async (req, res) => {
  try {
    const {
      search = "",
      status,
      paymentStatus,
      startDate,
      endDate,
      page = 1,
      limit = 10,
    } = req.query;

    const query = {};

    if (status) {
      query.status = status;
    }

    if (paymentStatus) {
      query.paymentStatus = paymentStatus;
    }

    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) query.createdAt.$gte = new Date(startDate);
      if (endDate) query.createdAt.$lte = new Date(endDate);
    }

    if (search) {
      const searchRegex = new RegExp(search, "i");

      const [matchingParents, matchingInvoices] = await Promise.all([
        Parent.find({
          $or: [
            { fullName: searchRegex },
            { email: searchRegex },
            { phone: searchRegex },
          ],
        }).select("_id"),
        Invoice.find({
          invoiceNumber: searchRegex,
        }).select("_id"),
      ]);

      const parentIds = matchingParents.map((p) => p._id);
      const invoiceIds = matchingInvoices.map((inv) => inv._id);

      query.$or = [
        { shippingAddress: searchRegex },
        { parent: { $in: parentIds } },
        { invoice: { $in: invoiceIds } },
      ];
    }

    const currentPage = Math.max(1, parseInt(page, 10) || 1);
    const pageLimit = Math.max(1, parseInt(limit, 10) || 10);
    const skip = (currentPage - 1) * pageLimit;

    const [orders, total] = await Promise.all([
      Order.find(query)
        .populate("parent", "fullName email phone address city")
        .populate({
          path: "items.product",
          select: "name price images stock category",
          populate: { path: "category", select: "name" },
        })
        .populate("invoice", "invoiceNumber paymentStatus status subtotal totalAmount amount dueDate description notes createdAt")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(pageLimit),
      Order.countDocuments(query),
    ]);

    return res.status(200).json({
      success: true,
      count: orders.length,
      pagination: {
        page: currentPage,
        limit: pageLimit,
        total,
        totalPages: Math.ceil(total / pageLimit),
        hasNextPage: skip + orders.length < total,
        hasPrevPage: currentPage > 1,
      },
      data: orders,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

// ✅ Get Order By ID (Admin)
exports.getOrderById = async (req, res) => {
  try {
    const { id } = req.params;

    const order = await Order.findById(id)
      .populate("parent", "fullName email phone address city emergencyContact relationship")
      .populate({
        path: "items.product",
        select: "name price images stock category",
        populate: { path: "category", select: "name" },
      })
      .populate("invoice");

    if (!order) {
      return res.status(404).json({
        success: false,
        message: "Order not found",
      });
    }

    return res.status(200).json({
      success: true,
      data: order,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

// ✅ Update Order Status (Admin)
exports.updateOrderStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, paymentStatus } = req.body;

    const order = await Order.findById(id);
    if (!order) {
      return res.status(404).json({
        success: false,
        message: "Order not found",
      });
    }

    if (status) order.status = status;
    if (paymentStatus) order.paymentStatus = paymentStatus;

    await order.save();

    const updatedOrder = await Order.findById(id)
      .populate("parent", "fullName email phone")
      .populate("invoice");

    return res.status(200).json({
      success: true,
      message: "Order status updated successfully",
      data: updatedOrder,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

// ✅ Get Parent's Orders (Parent only)
exports.getMyOrders = async (req, res) => {
  try {
    const parentId = req.parent._id;
    const { page = 1, limit = 10 } = req.query;

    const currentPage = Math.max(1, parseInt(page, 10) || 1);
    const pageLimit = Math.max(1, parseInt(limit, 10) || 10);
    const skip = (currentPage - 1) * pageLimit;

    const query = { parent: parentId };

    const [orders, total] = await Promise.all([
      Order.find(query)
        .populate({
          path: "items.product",
          select: "name price images stock category",
          populate: { path: "category", select: "name" },
        })
        .populate("invoice", "invoiceNumber paymentStatus status subtotal totalAmount amount dueDate description notes createdAt")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(pageLimit),
      Order.countDocuments(query),
    ]);

    return res.status(200).json({
      success: true,
      count: orders.length,
      pagination: {
        page: currentPage,
        limit: pageLimit,
        total,
        totalPages: Math.ceil(total / pageLimit),
      },
      data: orders,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

