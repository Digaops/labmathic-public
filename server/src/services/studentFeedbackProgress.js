// Pure read model: no application initialization or database dependency.
function summarizeFeedbackProgress(summary, released) {
  let pendingCount = 0, releasedCount = 0;
  const participants = summary.participants.map(participant => {
    let feedbackStatus = 'unavailable';
    if (participant.participationStatus !== 'exempted' && participant.attemptStatus === 'submitted') {
      feedbackStatus = released.has(participant.id) ? 'released' : 'pending';
      if (feedbackStatus === 'released') releasedCount += 1;
      else pendingCount += 1;
    }
    return { ...participant, feedbackStatus };
  });
  return { ...summary, participants,
    feedbackProgress: { eligibleCount: pendingCount + releasedCount, pendingCount, releasedCount } };
}

module.exports = { summarizeFeedbackProgress };
