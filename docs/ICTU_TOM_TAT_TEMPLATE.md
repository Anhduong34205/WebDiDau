# Tóm tắt mẫu đồ án/KLTN ICTU

Tài liệu nguồn của báo cáo trong dự án: `report/Main_DA_KLTN.tex`, `report/reportICTU.cls`, và các thư mục `report/bia/`, `report/chuong/`, `report/Figures/`, `report/Tai_lieu_tham_khao/`.

## 1. Mục đích

Template LaTeX ICTU trong `report/` dùng để biên soạn Đồ án tốt nghiệp hoặc Khóa luận tốt nghiệp theo định dạng thống nhất của Trường Đại học Công nghệ Thông tin và Truyền thông.

## 2. Công cụ và môi trường

- Overleaf: khuyến nghị cho làm việc trực tuyến, đồng bộ và biên dịch tức thì.
- Khi dùng Overleaf, compiler phải chuyển sang **XeLaTeX**.
- Offline trên Windows:
  - TeXstudio để sửa và soạn thảo LaTeX.
  - MiKTeX để biên dịch và quản lý package.
- Chỉ mở và biên dịch file chính `report/Main_DA_KLTN.tex`.
- Sau khi thêm/xóa/bỏ qua tài liệu tham khảo hoặc mục lục, Overleaf có thể cần biên dịch 2-3 lần để cập nhật số trang, danh mục và liên kết.

## 3. Cấu trúc thư mục template

```text
report/
├── Main_DA_KLTN.tex
├── reportICTU.cls
├── titletoc.sty
├── titlesec.sty
├── titledot.sty
├── bia/
│   ├── bia_chinh.tex
│   └── bia_phu.tex
├── chuong/
│   ├── loi_cam_doan.tex
│   ├── loi_cam_on.tex
│   ├── tu_viet_tat.tex
│   ├── phan_mo_dau.tex
│   ├── chuong_1.tex
│   ├── chuong_2.tex
│   ├── chuong_3.tex
│   ├── chuong_4.tex
│   ├── ket_luan.tex
│   └── nhan_xet_gvhd.tex
├── Figures/
├── Tai_lieu_tham_khao/
│   └── tai_lieu.bib
└── WebDiDau_KLTN.pdf
```

Không thay đổi hoặc xóa các file cấu hình như `reportICTU.cls` và các file `.sty` khi chưa hiểu rõ tác dụng.

## 4. Trình tự tài liệu

`report/Main_DA_KLTN.tex` điều phối toàn bộ tài liệu theo thứ tự:

1. Bìa chính
2. Bìa phụ
3. Lời cam đoan
4. Lời cảm ơn
5. Danh mục từ viết tắt
6. Mục lục
7. Danh sách bảng
8. Danh sách hình
9. Phần mở đầu
10. Chương 1: Cơ sở lý thuyết
11. Chương 2: Khảo sát và phân tích hệ thống
12. Chương 3: Thiết kế hệ thống
13. Chương 4: Kết quả và kiểm thử
14. Kết luận và kiến nghị
15. Tài liệu tham khảo
16. Nhận xét của giảng viên hướng dẫn

## 5. Định dạng bắt buộc trong template

- Khổ giấy A4.
- Tài liệu chính: one-side.
- Cỡ chữ chính: 12pt trong cấu hình hiện tại của `report/Main_DA_KLTN.tex`.
- Font: Times-based, package `mathptmx`.
- Tiếng Việt: package `vietnam` hoặc cấu hình Unicode tương ứng.
- Căn lề:
  - Trên: 2.0 cm
  - Dưới: 2.0 cm
  - Trái: 3.0 cm
  - Phải: 2.0 cm
- Khoảng cách dòng phần chính được thiết lập riêng cho từng vùng tài liệu.
- Mục chương được đánh số và tự động đưa vào mục lục.
- Số trang phần đầu dùng số La Mã; phần nội dung chính dùng số Ả Rập.

## 6. Phần mở đầu

Phần mở đầu cần có:

- Lý do chọn đề tài
- Mục tiêu nghiên cứu
- Đối tượng và phạm vi nghiên cứu
- Phương pháp nghiên cứu
- Cấu trúc báo cáo

## 7. Cấu trúc ba chương mẫu

### Chương 1: Cơ sở lý thuyết

- Tổng quan đề tài
- Cơ sở lý thuyết
- Công nghệ, thuật toán và mô hình nền tảng
- Các công trình hoặc hệ thống liên quan
- Ưu điểm, hạn chế và bài học kế thừa
- Định hướng giải quyết

### Chương 2: Khảo sát và phân tích hệ thống

- Khảo sát hiện trạng
- Phân tích yêu cầu chức năng
- Phân tích yêu cầu phi chức năng
- Phương pháp thực hiện
- Công cụ và dữ liệu sử dụng
- Kế hoạch thực hiện
- Use case, luồng nghiệp vụ, biểu đồ hoặc bảng phân tích khi cần

### Chương 3: Thiết kế hệ thống

- Thiết kế tổng thể
- Kiến trúc và mối quan hệ giữa các thành phần
- Thiết kế dữ liệu
- Thiết kế cơ sở dữ liệu hoặc cấu trúc lưu trữ
- Thiết kế chức năng
- Thiết kế giao diện hoặc mô hình thực nghiệm
- Luồng xử lý và sơ đồ minh họa

### Kết luận và kiến nghị

- Kết quả đạt được so với mục tiêu
- Hạn chế về dữ liệu, phạm vi, kỹ thuật hoặc thí nghiệm
- Hướng phát triển tiếp theo

## 8. Thông tin bìa

Chỉnh trong `report/bia/bia_chinh.tex` và `report/bia/bia_phu.tex`:

- Tên khoa
- Tên đề tài
- Giảng viên hướng dẫn
- Họ tên sinh viên
- Lớp
- Mã sinh viên
- Thái Nguyên và năm
- Logo ICTU

Không để placeholder mặc định như tên giả trong báo cáo nộp.

## 9. Hình ảnh

- Đặt file `.png`, `.jpg` hoặc `.eps` trong thư mục `report/Figures/Figures/`.
- Chèn bằng môi trường `figure`.
- Mỗi hình cần `caption` và `label`.
- Caption đặt phía dưới hình.
- Tham chiếu bằng `\ref{fig:...}` thay vì ghi số thủ công.
- Mỗi hình phải phục vụ giải thích và có lời giải thích trong phần văn bản.

## 10. Bảng biểu

- Chèn bằng môi trường `table`.
- Mỗi bảng cần `caption` và `label`.
- Caption đặt phía trên bảng.
- Tham chiếu bằng `\ref{tab:...}` thay vì ghi số thủ công.
- Bảng cần có tiêu đề cột, đơn vị và dữ liệu nhất quán.

## 11. Công thức toán

- Công thức xuất hiện trong dòng văn bản: đặt trong `$...$`.
- Công thức riêng một dòng có số thứ tự: dùng `equation`.
- Công thức không đánh số: dùng `equation*` hoặc mô hình tương đương.
- Hệ phương trình: dùng `align` hoặc môi trường tương thích.
- Mỗi công thức có ý nghĩa, ký hiệu và đơn vị được giải thích nếu có.
- Tham chiếu công thức bằng `\ref{eq:...}`.

## 12. Danh sách

- Danh sách không đánh số: `itemize`.
- Danh sách có đánh số: `enumerate`.
- Thuật toán: dùng môi trường `algorithm` và `algpseudocode`.
- Đặt tên đầu vào, đầu ra, bước và điều kiện dừng rõ ràng.

## 13. Trích dẫn tài liệu

- Trích dẫn BibTeX nằm trong `report/Tai_lieu_tham_khao/tai_lieu.bib`.
- Trong văn bản, trích dẫn bằng lệnh `\cite{key}`.
- Tài liệu tham khảo không được liệt kê thủ công rời rạc khỏi BibTeX.
- Trích dẫn cần nhất quán giữa file `.bib`, đoạn dẫn và danh mục tài liệu tham khảo.

## 14. Quy trình biên tập

1. Cập nhật thông tin sinh viên và đề tài trong hai file bìa ở `report/bia/`.
2. Viết từng phần trong thư mục `report/chuong/`.
3. Nếu thêm chương mới, tạo file trong `report/chuong/` và thêm lệnh `\input` vào `report/Main_DA_KLTN.tex`.
4. Đặt hình trong `report/Figures/Figures/` và tham chiếu bằng nhãn.
5. Cập nhật BibTeX trong `report/Tai_lieu_tham_khao/tai_lieu.bib`.
6. Biên dịch bằng XeLaTeX và chạy lại nếu mục lục, hình, bảng hoặc trích dẫn chưa cập nhật.

## 15. Checklist nộp báo cáo

- Đã thay toàn bộ thông tin placeholder.
- Không còn đoạn ghi “sinh viên trình bày...” trong báo cáo cuối.
- Mục lục, danh sách bảng và danh sách hình khớp số trang thực tế.
- Tất cả hình/bảng/công thức đều được trích dẫn trong nội dung.
- Tài liệu tham khảo có đầy đủ tác giả, năm, tên tài liệu và nguồn.
- Hình không bị vỡ, méo hoặc vượt lề.
- PDF biên dịch thành công bằng XeLaTeX.
- Không còn file backup `.bak` hoặc placeholder không liên quan trong bản nộp.
