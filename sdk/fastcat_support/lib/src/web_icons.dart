import 'package:flutter/material.dart';
import 'package:flutter_svg/flutter_svg.dart';

class WebIcon extends StatelessWidget {
  final String name;
  final double size;
  const WebIcon(this.name, {super.key, this.size = 18});
  @override
  Widget build(BuildContext context) {
    final path = switch (name) {
      'send' => '<path d="m22 2-7 20-4-9-9-4 20-7Z"/><path d="M22 2 11 13"/>',
      'emoji' =>
        '<circle cx="12" cy="12" r="9"/><path d="M8 14s1 3 4 3 4-3 4-3M8.5 8.5h.01m7 0h.01"/>',
      'attach' =>
        '<path d="m21 11-8.5 8.5a6 6 0 0 1-8.5-8.5l9-9a4 4 0 0 1 5.7 5.7l-9 9a2 2 0 0 1-2.8-2.8l8.5-8.5"/>',
      _ =>
        '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/>${name == 'muted' ? '<path d="m3 3 18 18"/>' : ''}',
    };
    return SvgPicture.string(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">$path</svg>',
        width: size,
        height: size,
        colorFilter: ColorFilter.mode(
            IconTheme.of(context).color ??
                DefaultTextStyle.of(context).style.color ??
                Colors.black,
            BlendMode.srcIn));
  }
}
