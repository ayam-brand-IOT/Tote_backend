const transitions = {
  empty: ['inbound-ready'],
  'inbound-ready': ['product-linked'],
  'product-linked': ['outbound-ready'],
  'outbound-ready': ['in-transit'],
  'in-transit': ['received-for-packing'],
  'received-for-packing': ['offloaded-to-clean'],
  'offloaded-to-clean': [],
};

async function hasDestination(db, recordId) {
  const [links] = await db.query('SELECT destination FROM tote_line WHERE tote_record_id = ?', [recordId]);
  return links.length > 0 && links.every(link => typeof link.destination === 'string' && link.destination.trim().length > 0);
}

// Serialize lifecycle writes per physical tote, including the first cycle.
// Buffer the JSON response until its transaction has committed.
function lifecycleRoute(pool, handler) {
  return async (req, res) => {
    let connection;
    const send = res.json.bind(res);
    let payload;
    const notifications = [];
    req.afterLifecycleCommit = callback => notifications.push(callback);
    try {
      connection = await pool.getConnection();
      await connection.beginTransaction();
      await connection.query('SELECT tote_id FROM tote_assets WHERE tote_id = ? FOR UPDATE',
        [req.params.id || req.body.tote_id || '']);
      res.json = body => { payload = body; return res; };
      await handler(req, res, connection);
      if (res.statusCode >= 400) await connection.rollback();
      else {
        await connection.commit();
        for (const notify of notifications) {
          try { notify(); } catch (error) { console.error('Lifecycle notification failed:', error); }
        }
      }
      res.json = send;
      return send(payload);
    } catch (error) {
      if (connection) await connection.rollback().catch(() => {});
      res.json = send;
      console.error('Lifecycle transaction failed:', error);
      return res.status(500).json({ error: 'Internal server error' });
    } finally {
      if (connection) connection.release();
    }
  };
}

module.exports = { transitions, hasDestination, lifecycleRoute };
