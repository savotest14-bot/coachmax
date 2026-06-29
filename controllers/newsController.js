const News = require("../models/News");

// ✅ Create Announcement / News (Admin only)
exports.createNews = async (req, res) => {
  try {
    const { title, description, category, featured } = req.body;

    if (!title || !description) {
      return res.status(400).json({ success: false, message: "Title and description are required" });
    }

    let images = [];
    if (req.files) {
      images = req.files.map((file) => `uploads/news/${file.filename}`);
    } else if (req.file) {
      images = [`uploads/news/${req.file.filename}`];
    }

    const news = await News.create({
      title,
      description,
      images,
      category,
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

// ✅ Fetch all News / Announcements (Public / Parents / Coaches)
exports.getAllNews = async (req, res) => {
  try {
    const { featured, category } = req.query;
    const query = {};

    if (featured !== undefined) {
      query.featured = featured === "true" || featured === true;
    }
    if (category) {
      query.category = category;
    }

    const news = await News.find(query)
      .populate("publishedBy", "name email")
      .sort({ publishedAt: -1 });

    res.json({ success: true, count: news.length, data: news });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
