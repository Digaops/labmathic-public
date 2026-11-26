const { integer } = require('../services/adminReadInputs');

// Preserve the cap for valid large requests without letting SQLite interpret
// negative limits as unlimited or accepting malformed query values.
module.exports = function listingLimit(fallback, maximum) {
  return (req, res, next) => {
    try {
      res.locals.listingLimit = integer(req.query.limit, fallback, maximum);
    } catch (error) {
      if (error.status !== 400) return next(error);
      return res.status(400).json({ error: 'Informe limit como um número inteiro positivo.' });
    }
    next();
  };
};
