const toast=document.querySelector('#toast');
function showToast(message){toast.textContent=message;toast.classList.add('show');setTimeout(()=>toast.classList.remove('show'),2400)}
document.querySelector('#reviewBtn').addEventListener('click',()=>{document.querySelector('#review').scrollIntoView({behavior:'smooth'});showToast('Đã mở hàng đợi kiểm tra')});
document.querySelector('#newChapter').addEventListener('click',()=>showToast('Tạo chương mới — sẵn sàng nhập nội dung'));
document.querySelector('#filterBtn').addEventListener('click',()=>showToast('Bộ lọc: tất cả câu thoại'));
document.querySelectorAll('.queue-item').forEach(item=>item.addEventListener('click',()=>{document.querySelectorAll('.queue-item').forEach(x=>x.classList.remove('selected'));item.classList.add('selected');showToast('Đã chọn câu thoại')}));
