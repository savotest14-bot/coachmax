const Product = require("../models/Product");
const ProductCategory = require("../models/ProductCategory");
const Cart = require("../models/Cart");
const Order = require("../models/Order");
const Invoice = require("../models/Invoice");
const Parent = require("../models/Parent");
const mongoose = require("mongoose");
const { checkout: checkoutOrder } = require("../services/checkoutService");
const { currencyAmount } = require("../utils/money");
let broadcastSidebarBadges = null;
try {
  ({ broadcastSidebarBadges } = require("../sockets/chatSocket"));
} catch (e) {}

exports.createCategory = async (req, res) => {
  try {
    const { name, description } = req.body;
    if (!name) {
      return res.status(400).json({ success: false, message: "name is required" });
    }

    const category = await ProductCategory.create({ name, description });
    res.status(201).json({ success: true, message: "Product category created", data: category });
  } catch (err) {
    res.status(err.statusCode || err.status || (err.name === "CastError" || err.name === "ValidationError" || err instanceof SyntaxError ? 400 : err.name === "VersionError" || err.code === 11000 ? 409 : 500)).json({ success: false, message: err.message });
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
    res.status(err.statusCode || err.status || (err.name === "CastError" || err.name === "ValidationError" || err instanceof SyntaxError ? 400 : err.name === "VersionError" || err.code === 11000 ? 409 : 500)).json({
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
    res.status(err.statusCode || err.status || (err.name === "CastError" || err.name === "ValidationError" || err instanceof SyntaxError ? 400 : err.name === "VersionError" || err.code === 11000 ? 409 : 500)).json({
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
    res.status(err.statusCode || err.status || (err.name === "CastError" || err.name === "ValidationError" || err instanceof SyntaxError ? 400 : err.name === "VersionError" || err.code === 11000 ? 409 : 500)).json({
      success: false,
      message: err.message,
    });
  }
};

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

    if (!name || !category || price === undefined || price === "") {
      return res.status(400).json({
        success: false,
        message: "Product name, category and price are required.",
      });
    }

    if (!Number.isSafeInteger(Number(stock || 0)) || Number(stock || 0) < 0) return res.status(400).json({ success: false, message: "Stock must be a non-negative integer" });
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
      price: currencyAmount(price),
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
    return res.status(error.statusCode || error.status || (error.name === "CastError" || error.name === "ValidationError" || error instanceof SyntaxError ? 400 : error.name === "VersionError" || error.code === 11000 ? 409 : 500)).json({
      success: false,
      message: error.message,
    });
  }
};

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

    const currentPage = Math.max(1, parseInt(page, 10) || 1);
    const pageLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 10));
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
    return res.status(err.statusCode || err.status || (err.name === "CastError" || err.name === "ValidationError" || err instanceof SyntaxError ? 400 : err.name === "VersionError" || err.code === 11000 ? 409 : 500)).json({
      success: false,
      message: err.message,
    });
  }
};

exports.getAdminProducts = async (req, res) => {
  try {
    const {
      search = "",
      category,
      categoryId,
      status = 'ACTIVE',
      availabilityStatus,
      page = 1,
      limit = 10,
    } = req.query;

    const query = {};

    const targetCategory = categoryId || category;
    if (targetCategory) {
      query.category = targetCategory;
    }

    if (status) {
      query.status = status;
    }

    if (availabilityStatus) {
      query.availabilityStatus = availabilityStatus;
    }

    if (search) {
      query.$or = [
        { name: { $regex: search, $options: "i" } },
        { description: { $regex: search, $options: "i" } },
      ];
    }

    const currentPage = Math.max(1, parseInt(page, 10) || 1);
    const pageLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 10));
    const skip = (currentPage - 1) * pageLimit;

    const [products, total] = await Promise.all([
      Product.find(query)
        .populate("category", "name description")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(pageLimit),
      Product.countDocuments(query),
    ]);

    return res.status(200).json({
      success: true,
      count: products.length,
      data: products,
      pagination: {
        page: currentPage,
        limit: pageLimit,
        total,
        totalPages: Math.ceil(total / pageLimit),
        hasMore: skip + products.length < total,
        nextPage: skip + products.length < total ? currentPage + 1 : null,
      },
    });
  } catch (err) {
    return res.status(err.statusCode || err.status || (err.name === "CastError" || err.name === "ValidationError" || err instanceof SyntaxError ? 400 : err.name === "VersionError" || err.code === 11000 ? 409 : 500)).json({
      success: false,
      message: err.message,
    });
  }
};

exports.getProductById = async (req, res) => {
  try {
    const { id } = req.params;
    const product = await Product.findById(id).populate("category", "name description");

    if (!product) {
      return res.status(404).json({
        success: false,
        message: "Product not found",
      });
    }

    return res.status(200).json({
      success: true,
      data: product,
    });
  } catch (error) {
    return res.status(error.statusCode || error.status || (error.name === "CastError" || error.name === "ValidationError" || error instanceof SyntaxError ? 400 : error.name === "VersionError" || error.code === 11000 ? 409 : 500)).json({
      success: false,
      message: error.message,
    });
  }
};

exports.updateProduct = async (req, res) => {
  try {
    const { id } = req.params;
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
      status,
      existingImages,
    } = req.body;

    const product = await Product.findById(id);
    if (!product) {
      return res.status(404).json({
        success: false,
        message: "Product not found",
      });
    }

    if (name !== undefined) product.name = name;
    if (shortHighlight !== undefined) product.shortHighlight = shortHighlight;
    if (description !== undefined) product.description = description;
    if (category !== undefined) product.category = category;
    if (price !== undefined) product.price = currencyAmount(price);
    if (stock !== undefined) {
      if (!Number.isSafeInteger(Number(stock)) || Number(stock) < 0) return res.status(400).json({ success: false, message: "Stock must be a non-negative integer" });
      product.stock = Number(stock);
    }
    if (availabilityStatus !== undefined) product.availabilityStatus = availabilityStatus;
    if (status !== undefined) product.status = status;

    if (sizes !== undefined) {
      product.sizes = Array.isArray(sizes)
        ? sizes
        : typeof sizes === "string"
          ? JSON.parse(sizes)
          : [];
    }

    if (colors !== undefined) {
      product.colors = Array.isArray(colors)
        ? colors
        : typeof colors === "string"
          ? JSON.parse(colors)
          : [];
    }

    let updatedImages = [];
    if (existingImages) {
      updatedImages = Array.isArray(existingImages)
        ? existingImages
        : typeof existingImages === "string"
          ? JSON.parse(existingImages)
          : [];
    } else if (!req.files || req.files.length === 0) {
      updatedImages = product.images;
    }

    if (req.files && req.files.length > 0) {
      const newImages = req.files.map(
        (file) => `uploads/images/${file.filename}`
      );
      updatedImages = [...updatedImages, ...newImages];
    }

    product.images = updatedImages;

    await product.save();

    const populatedProduct = await Product.findById(id).populate("category", "name");

    return res.status(200).json({
      success: true,
      message: "Product updated successfully.",
      data: populatedProduct,
    });
  } catch (error) {
    return res.status(error.statusCode || error.status || (error.name === "CastError" || error.name === "ValidationError" || error instanceof SyntaxError ? 400 : error.name === "VersionError" || error.code === 11000 ? 409 : 500)).json({
      success: false,
      message: error.message,
    });
  }
};

exports.deleteProduct = async (req, res) => {
  try {
    const { id } = req.params;

    const product = await Product.findById(id);
    if (!product) {
      return res.status(404).json({
        success: false,
        message: "Product not found",
      });
    }

    product.status = "INACTIVE";
    await product.save();

    return res.status(200).json({
      success: true,
      message: "Product deleted successfully.",
      data: product,
    });
  } catch (error) {
    return res.status(error.statusCode || error.status || (error.name === "CastError" || error.name === "ValidationError" || error instanceof SyntaxError ? 400 : error.name === "VersionError" || error.code === 11000 ? 409 : 500)).json({
      success: false,
      message: error.message,
    });
  }
};

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

    if (!Number.isSafeInteger(quantity) || quantity < 0 || quantity > 1000) {
      return res.status(400).json({
        success: false,
        message: "Quantity must be an integer between 0 and 1000",
      });
    }

    const product = await Product.findById(productId);
    if (!product || product.status !== "ACTIVE") {
      return res.status(404).json({
        success: false,
        message: "Product not found",
      });
    }

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
        cart.items.splice(itemIndex, 1);
      } else {
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
    return res.status(err.statusCode || err.status || (err.name === "CastError" || err.name === "ValidationError" || err instanceof SyntaxError ? 400 : err.name === "VersionError" || err.code === 11000 ? 409 : 500)).json({
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
    if (!product || product.status !== "ACTIVE") return res.status(409).json({ success: false, message: "Product is no longer available" });
    if (!["increment", "decrement"].includes(action)) return res.status(400).json({ success: false, message: "Action must be increment or decrement" });

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
    res.status(err.statusCode || err.status || (err.name === "CastError" || err.name === "ValidationError" || err instanceof SyntaxError ? 400 : err.name === "VersionError" || err.code === 11000 ? 409 : 500)).json({
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
    res.status(err.statusCode || err.status || (err.name === "CastError" || err.name === "ValidationError" || err instanceof SyntaxError ? 400 : err.name === "VersionError" || err.code === 11000 ? 409 : 500)).json({
      success: false,
      message: err.message,
    });
  }
};

exports.getCart = async (req, res) => {
  try {
    const parentId = req.parent._id;

    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(100, Math.max(parseInt(req.query.limit) || 10, 1));
    const skip = (page - 1) * limit;

    let cart = await Cart.findOne({ parent: parentId })
      .populate("items.product", "name price images stock status");

    if (!cart) cart = { _id: null, parent: parentId, items: [] };

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
    res.status(err.statusCode || err.status || (err.name === "CastError" || err.name === "ValidationError" || err instanceof SyntaxError ? 400 : err.name === "VersionError" || err.code === 11000 ? 409 : 500)).json({
      success: false,
      message: err.message,
    });
  }
};

exports.checkout = async (req, res) => {
  try {
    const result = await checkoutOrder({ parentId: req.parent?._id, shippingAddress: req.body.shippingAddress, idempotencyKey: req.get("Idempotency-Key") || req.body.idempotencyKey });
    if (broadcastSidebarBadges) broadcastSidebarBadges().catch(() => {});
    return res.status(result.repeated ? 200 : 201).json({ success: true, message: result.repeated ? "This order was already placed" : "Order placed successfully. Invoice generated.", repeated: result.repeated, data: { order: result.order, invoice: result.invoice } });
  } catch (error) {
    return res.status(error.statusCode || error.status || (error.name === "ValidationError" || error.name === "CastError" ? 400 : error.code === 11000 || error.name === "VersionError" ? 409 : 500)).json({ success: false, message: error.message });
  }
};

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
    const pageLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 10));
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
    return res.status(err.statusCode || err.status || (err.name === "CastError" || err.name === "ValidationError" || err instanceof SyntaxError ? 400 : err.name === "VersionError" || err.code === 11000 ? 409 : 500)).json({
      success: false,
      message: err.message,
    });
  }
};

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
    return res.status(err.statusCode || err.status || (err.name === "CastError" || err.name === "ValidationError" || err instanceof SyntaxError ? 400 : err.name === "VersionError" || err.code === 11000 ? 409 : 500)).json({
      success: false,
      message: err.message,
    });
  }
};

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

    if (broadcastSidebarBadges) {
      broadcastSidebarBadges().catch(() => {});
    }

    return res.status(200).json({
      success: true,
      message: "Order status updated successfully",
      data: updatedOrder,
    });
  } catch (err) {
    return res.status(err.statusCode || err.status || (err.name === "CastError" || err.name === "ValidationError" || err instanceof SyntaxError ? 400 : err.name === "VersionError" || err.code === 11000 ? 409 : 500)).json({
      success: false,
      message: err.message,
    });
  }
};

exports.getMyOrders = async (req, res) => {
  try {
    const parentId = req.parent._id;
    const { page = 1, limit = 10 } = req.query;

    const currentPage = Math.max(1, parseInt(page, 10) || 1);
    const pageLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 10));
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
    return res.status(err.statusCode || err.status || (err.name === "CastError" || err.name === "ValidationError" || err instanceof SyntaxError ? 400 : err.name === "VersionError" || err.code === 11000 ? 409 : 500)).json({
      success: false,
      message: err.message,
    });
  }
};

