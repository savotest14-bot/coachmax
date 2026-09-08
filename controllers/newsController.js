const News = require("../models/News");
const fs = require("fs");
const path = require("path");

exports.createNews = async (req, res) => {
  try {
    const { title, description, category, featured } = req.body;

    if (!title || !description) {
      return res.status(400).json({ success: false, message: "Title and description are required" });
    }

    let images = [];
    if (req.files && req.files.length > 0) {
      images = req.files.map((file) => `uploads/images/${file.filename}`);
    } else if (req.file) {
      images = [`uploads/images/${req.file.filename}`];
    }

    const news = await News.create({
      title,
      description,
      images,
      category: category || "General",
      featured: featured === "true" || featured === true,
      publishedBy: req.admin._id,
    });

    res.status(201).json({
      success: true,
      message: "News announcement published successfully",
      data: news,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.getAllNews = async (req, res) => {
  try {
    const { featured, category, search } = req.query;
    const query = {};

    if (featured !== undefined && featured !== "") {
      query.featured = featured === "true" || featured === true;
    }
    if (category) {
      query.category = category;
    }
    if (search) {
      query.$or = [
        { title: { $regex: search, $options: "i" } },
        { description: { $regex: search, $options: "i" } },
      ];
    }

    const news = await News.find(query)
      .populate("publishedBy", "name email")
      .sort({ publishedAt: -1 });

    res.json({ success: true, count: news.length, data: news });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.getNewsById = async (req, res) => {
  try {
    const { id } = req.params;
    const news = await News.findById(id).populate("publishedBy", "name email");

    if (!news) {
      return res.status(404).json({ success: false, message: "News not found" });
    }

    res.json({ success: true, data: news });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.updateNews = async (req, res) => {
  try {
    const { id } = req.params;
    const { title, description, category, featured, keepExistingImages } = req.body;

    const news = await News.findById(id);
    if (!news) {
      return res.status(404).json({ success: false, message: "News article not found" });
    }

    if (title) news.title = title;
    if (description) news.description = description;
    if (category) news.category = category;
    if (featured !== undefined && featured !== "") {
      news.featured = featured === "true" || featured === true;
    }

    if (req.files && req.files.length > 0) {
      const newImages = req.files.map((file) => `uploads/images/${file.filename}`);
      if (keepExistingImages === "false" || keepExistingImages === false) {
        (news.images || []).forEach((imgRelPath) => {
          const fullPath = path.join(__dirname, "..", imgRelPath);
          if (fs.existsSync(fullPath)) {
            fs.unlink(fullPath, (unlinkErr) => {
              if (unlinkErr) console.error("Error unlinking image:", unlinkErr.message);
            });
          }
        });
        news.images = newImages;
      } else {
        news.images = [...(news.images || []), ...newImages];
      }
    } else if (req.file) {
      const newImage = `uploads/images/${req.file.filename}`;
      if (keepExistingImages === "false" || keepExistingImages === false) {
        (news.images || []).forEach((imgRelPath) => {
          const fullPath = path.join(__dirname, "..", imgRelPath);
          if (fs.existsSync(fullPath)) {
            fs.unlink(fullPath, (unlinkErr) => {
              if (unlinkErr) console.error("Error unlinking image:", unlinkErr.message);
            });
          }
        });
        news.images = [newImage];
      } else {
        news.images = [...(news.images || []), newImage];
      }
    }

    await news.save();

    res.json({
      success: true,
      message: "News article updated successfully",
      data: news,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.deleteNews = async (req, res) => {
  try {
    const { id } = req.params;

    const news = await News.findById(id);
    if (!news) {
      return res.status(404).json({ success: false, message: "News article not found" });
    }

    if (news.images && news.images.length > 0) {
      news.images.forEach((imgRelPath) => {
        const fullPath = path.join(__dirname, "..", imgRelPath);
        if (fs.existsSync(fullPath)) {
          fs.unlink(fullPath, (unlinkErr) => {
            if (unlinkErr) console.error("Error unlinking image:", unlinkErr.message);
          });
        }
      });
    }

    await News.findByIdAndDelete(id);

    res.json({
      success: true,
      message: "News article permanently deleted successfully",
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.getNewsCategories = async (req, res) => {
  try {
    const rawCategories = await News.distinct("category");
    const categories = [
      ...new Set(rawCategories.filter(Boolean).map((c) => String(c).trim())),
    ];

    res.json({
      success: true,
      count: categories.length,
      data: categories,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
