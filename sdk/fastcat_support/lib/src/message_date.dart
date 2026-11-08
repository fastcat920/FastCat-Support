/// Match bubble times: interpret the timestamp once and use the device timezone.
String localMessageDay(String? timestamp) {
  final value = DateTime.tryParse(timestamp ?? '')?.toLocal();
  if (value == null) return '';
  return '${value.year.toString().padLeft(4, '0')}-${value.month.toString().padLeft(2, '0')}-${value.day.toString().padLeft(2, '0')}';
}
